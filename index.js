'use strict'

const botframework = require('botbuilder')
const XmppClient = require('node-xmpp-client')
const uuid = require('node-uuid')
const Promise = require('bluebird')
const debug = require('debug')('botbuilder-hipchat')

/*
HipchatBot connects over XMPP to the HipChat servers. The simple use is a
private message partner for 1-1 conversations, where the bot acts as an agent.

A keep alive loop exists in two parts:
* a short keep alive to prevent network disconnect
* a long keep alive, that keeps the bot alive be reconnecting to HipChat if interrupted

Errors fire an `error` event, or if there is no handler, stream to `console.error`.
*/
module.exports =
  class HipchatBot extends botframework.DialogCollection {
    constructor (options) {
      super(options)
      this.options = options
      this.options.defaultDialogId = '/'
      this.options.sessionStore = options.sessionStore || new botframework.MemoryStorage()
      this.options.userStore = options.userStore || new botframework.MemoryStorage()
      // promises resolvers from the future -- for message callbacks from XMPP since we can't really
      // get a closure over it -- key these by message id
      this.resolvers = {}
      this.directory = {}
      this.profile = {}
    }

    /*
    Ask for a full profile by jid, come back with a promise for the full profile.
    */
    fullProfile (jid) {
      let resolvers = this.resolvers
      let client = this.client
      return new Promise((resolve) => {
        let id = `profile:${uuid.v1()}`
        resolvers[id] = resolve
        client.send(new XmppClient.Stanza('iq', {id: id, to: jid.bare().toString(), type: 'get'})
          .c('query', {xmlns: 'http://hipchat.com/protocol/profile'})
          .up().c('time', {xmlns: 'urn:xmpp:time'}).root())
      })
    }

    /**
     * Process if the stanza is a vcard, returning true if it was handled.
     * 
     * @param stanza
     */
    maybeVCard (stanza) {
      if (Object.is(stanza.name, 'iq') && stanza.getChild('vCard')) {
        stanza.getChild('vCard').children.forEach((field) => this.profile[field.name] = field.getText())
        return true
      }
    }

    /**
     * Process a single profile coming back from the server, merging it into the directory, and if
     * there is an outstanding promise for this profile -- resolve it.
     * 
     * @param stanza
     */
    maybeProfile (stanza) {
      // may be a single person, look them up or make a profile record
      if (Object.is(stanza.name, 'iq') && (stanza.attrs.id || '').indexOf('profile:') == 0) {
        let jid = new XmppClient.JID(stanza.attrs.from)
        let buddy = undefined
        if (this.directory[jid.bare().toString()]) {
          buddy = this.directory[jid.bare().toString()]
        } else {
          buddy = {}
        }
        buddy.jid = jid
        try {
          buddy.name = stanza.getChildren('query')[0].getChildren('name')[0].children[0]
          buddy.mention_name = stanza.getChildren('query')[0].getChildren('mention_name')[0].children[0]
          buddy.timezone = Number(stanza.getChildren('query')[0].getChildren('timezone')[0].attrs.utc_offset)
        } catch(e) {
          this.emit('error', e)
        }
        debug('hi', JSON.stringify(buddy))
        this.directory[jid.bare().toString()] = buddy
        let resolver = this.resolvers[stanza.attrs.id]
        if (resolver) resolver(buddy)
        return true
      }
    }

    /**
     * Process a a query result having other users in he buddly list subscription
     * 
     * @param stanza
     */
    maybeBuddyList (stanza) {
      // the directory, load it all up in a hash
      let query = stanza.getChild('query')
      if (query && query.getChildren('item')) {
        (query.getChildren('item') || []).forEach((el) => {
          let jid = new XmppClient.JID(el.attrs.jid)
          let buddy = this.directory[jid.bare().toString()] || {}
          buddy.jid = jid
          buddy.name = el.attrs.name
          buddy.mention_name = el.attrs.mention_name
          debug('hi', JSON.stringify(buddy))
          this.directory[jid.bare().toString()] = buddy
        })
        return true
      }
    }

    /**
     * Process a plain chat message, this hooks into a bot dialog session based on the user.
     * 
     * @param stanza 
     */
    maybeMessage (stanza) {
      if (Object.is(stanza.name, 'message') && Object.is(stanza.attrs.type, 'chat') && stanza.getChildText('body')) {
        // hoisting properties
        stanza.id = uuid.v1()
        stanza.to = new XmppClient.JID(stanza.attrs.to)
        stanza.from = new XmppClient.JID(stanza.attrs.from)
        stanza.text = stanza.getChildText('body')
        const ses = new botframework.Session({
          localizer: this.options.localizer,
          dialogs: this,
          dialogId: this.options.defaultDialogId,
          dialogArgs: {}
        })
        let getSession = Promise.promisify(this.options.sessionStore.get.bind(this.options.sessionStore))
        let getUser = Promise.promisify(this.options.userStore.get.bind(this.options.userStore))
        Promise.join(
          getSession(stanza.from.bare().toString()),
          getUser(stanza.from.bare().toString())
        ).then((arg) => {
          let sessionData = arg[0]
          let userData = arg[1]
          ses.userData = userData || {}
          // pull in the user from the directory
          ses.userData.identity = this.directory[stanza.from.bare().toString()]
          ses.dispatch(sessionData, stanza)
        })
        // observe the session, and forward sends back to the server after saving data
        // created first -- memory store appears to be synchronous, otherwise the 'send' is not
        // trapped
        ses.on('send', (msg) => {
          if (!msg) return
          let setSession = Promise.promisify(this.options.sessionStore.save.bind(this.options.sessionStore))
          let setUser = Promise.promisify(this.options.userStore.save.bind(this.options.userStore))
          Promise.join(
            setSession(stanza.from.bare().toString(), ses.sessionState),
            setUser(stanza.from.bare().toString(), ses.userData)
          ).then(() => {
            let backToWho = this.directory[stanza.from.bare().toString()]
            this.client.send(new XmppClient.Stanza('message', {id: uuid.v1(), to: stanza.from, type: 'chat'})
              .c('body').t(msg.text).root().c('time', {xmlns: 'urn:xmpp:time'}))
            this.emit('send', msg)
          })
        })
        return true
      }
    }

    /**
     * Build up a new connection with the options, and hook it event handlers
     * 
     * @returns {Promise} - resolved when this client connection is online.
     */
    listen () {
      // actual connection
      let client = this.client = new XmppClient({
        jid: this.options.uid,
        password: this.options.pwd,
        host: this.options.host
      })
      // event processing for incoming stanzas from the server
      client.on('stanza', (stanza) => {
        this.maybeVCard(stanza) ||
        this.maybeProfile(stanza) ||
        this.maybeBuddyList(stanza) ||
        this.maybeMessage(stanza)
      })

      // promise for a complete online connection
      return new Promise((resolve) => {
        client.on('online', resolve)
      }).then(() => {
        // now we are online, start getting roster and status, along with a vcard for this bot itself
        client.send(new XmppClient.Stanza('iq', { type: 'get' }).c('vCard', { xmlns: 'vcard-temp' }).root())
        client.send(new XmppClient.Stanza('iq', { type: 'get' }).c('query', { xmlns: 'jabber:iq:roster' }).root())
        client.send(new XmppClient.Stanza('presence', {}).c('show').t('chat').up().c('status').t(this.options.status || '').root())
        return true
      }).then(() => {
        // and start up a keepalive
        this.keepalive = setInterval(() => {
          client.send(new XmppClient.Message())
        }, 30 * 1000)
        return true
      })
    }

}
