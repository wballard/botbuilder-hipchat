'use strict'

const botframework = require('botbuilder')
const XmppClient = require('node-xmpp-client')
const uuid = require('node-uuid')
const Promise = require('bluebird')
const _ = require('lodash')
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
      super()
      this.options = options
      this.options.defaultDialogId = '/'
      this.options.sessionStore = options.sessionStore || new botframework.MemoryStorage()
      this.options.userStore = options.userStore || new botframework.MemoryStorage()
      // promises resolvers from the future -- for message callbacks from XMPP since we can't really
      // get a closure over it -- key these by message id
      this.resolvers = {}
      // all the other users we know
      this.directory = {}
      // the bot profile
      this.profile = {}
    }

    /**
     * Ask for a full profile by jid, come back with a promise for the full profile.* 
     * 
     * @param jid - fetch for this user
     * @returns {Promise} - resolves with the profile
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
     * Process if the stanza is a vcard, returning true if it was handled. This is the profile for
     * the bot user itself.
     * 
     * @param stanza
     */
    maybeVCard (stanza) {
      if (Object.is(stanza.name, 'iq') && stanza.getChild('vCard')) {
        this.profile.jid = new XmppClient.JID(stanza.attrs.to)
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
          buddy.timezone = stanza.getChildren('query')[0].getChildren('timezone')[0].text()
          buddy.utc_offset = Number(stanza.getChildren('query')[0].getChildren('timezone')[0].attrs.utc_offset)
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
     * Process a query result having other users in the buddly list subscription, this will update
     * the bot in memory profile directory.
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
          debug('profile', JSON.stringify(buddy))
          this.directory[jid.bare().toString()] = buddy
        })
        return true
      }
    }

    /**
     * Check for presence and update the directory.
     * 
     * @param stanza (description)
     */
    maybePresence (stanza) {
      if (Object.is(stanza.name, 'presence')) {
        let jid = new XmppClient.JID(stanza.attrs.from)
        let buddy = this.directory[jid.bare().toString()] || {}
        let show = (stanza.getChildren('show') || []).map((i) => i.getText()).join('')
        show = show.length ? show : null
        buddy.presence = show || stanza.attrs.type || 'online'
        debug('presence', JSON.stringify(buddy))
        this.directory[jid.bare().toString()] = buddy
      }
    }

    /**
     * Process a plain chat message, this hooks into a bot dialog session based on the user.
     * 
     * @param stanza 
     */
    maybeMessage (stanza) {
      let ret = false
      if (Object.is(stanza.name, 'message') && stanza.getChildText('body') && (Object.is(stanza.attrs.type, 'chat') || Object.is(stanza.attrs.type, 'groupchat'))) {
        // check for a resolver, this is an early exit as it is just an echo
        if (this.resolvers[stanza.attrs.id]) {
          this.resolvers[stanza.attrs.id]()
          debug('receipt for', stanza.attrs.id)
          return true
        }
        // the from / to is a bit when we are in groupchat
        let messageFrom = new XmppClient.JID(stanza.attrs.from)
        let messageUser
        if (Object.is(stanza.attrs.type, 'chat')) {
          messageUser = messageFrom
        }
        if (Object.is(stanza.attrs.type, 'groupchat')) {
          let users = _.values(this.directory)
          let user = _.find(users, (u) => Object.is(u.name, messageFrom.getResource()))
          if (!user) {
            this.emit('warn', `No user ${messageFrom.getResource()}`)
            return false
          }
          messageUser = user.jid
        }
        stanza.id = uuid.v1()
        stanza.text = stanza.getChildText('body') || ''
        // if this is a message 'from' the bot-- it is a reply
        if (Object.is(this.profile.jid.bare().toString(), messageUser.bare().toString())) {
          this.emit('reply', stanza)
          return true
        }
        // start up a session 
        const ses = new botframework.Session({
          localizer: this.options.localizer,
          dialogs: this,
          dialogId: this.options.defaultDialogId,
          dialogArgs: {}
        })
        Promise.join(
          this.getSessionData(messageUser),
          this.getUserData(messageUser)
        ).then((arg) => {
          let sessionData = arg[0]
          let userData = arg[1]
          ses.userData = userData || {}
          // pull in the user from the directory
          ses.userData.identity = this.directory[messageUser.bare().toString()]
          if (Object.is(stanza.attrs.type, 'groupchat')) {
            let filter = Promise.promisify(this.groupFilter || ((sessionData, stanza, cb) => cb(null, true) ))
            filter(sessionData, stanza)
              .then((shouldDispatch) => {
                if (shouldDispatch) {
                  ses.dispatch(sessionData, stanza)
                  ret = true
                }
              })
          } else {
            ses.dispatch(sessionData, stanza)
            stanza.getChildText('body')
          }
        })
        // observe the session, and forward sends back to the server after saving data
        ses.on('send', (msg) => {
          if (!msg) return
          Promise.join(
            this.setSessionData(messageUser, ses.sessionState),
            this.setUserData(messageUser, ses.userData)
          ).then(() => {
            if (Object.is(stanza.attrs.type, 'chat')) {
              this.send(messageFrom, msg.text)
              messageUser = messageFrom
            }
            if (Object.is(stanza.attrs.type, 'groupchat')) {
              this.sendChat(messageFrom, msg.text)
            }
            this.emit('send', msg)
          })
        })
      }
      return ret
    }

    /**
     * This bot is what we'd call 'a joiner'. All invites get an immediate join response to
     * the room.
     * 
     * @param stanza (description)
     * @returns (description)
     */
    maybeInvite (stanza) {
      var ret = false
      if (Object.is(stanza.name, 'message')) {
        stanza.getChildren('x').forEach((x) => {
          x.getChildren('invite').forEach((invite) => {
            var room = new XmppClient.JID(stanza.attrs.from)
            this.client.send(
              new XmppClient.Stanza('presence', {to: `${room.toString()}/${this.profile.FN}`})
                .c('x', { xmlns: 'http://jabber.org/protocol/muc' })
                .c('history', {
                  xmlns: 'http://jabber.org/protocol/muc',
                  maxstanzas: '2'
                })
                .root()
            )
          })
        })
      }
      return ret
    }

    /**
     * Promise to get the data for a single user, and always come back with at least a default hash.
     * 
     * @param jid - identifies which user
     * @returns {Promise} - resolves to the user data
     */
    getUserData (jid) {
      return Promise.promisify(this.options.userStore.get.bind(this.options.userStore))(jid.bare().toString())
        .then((userdata) => userdata || {})
    }

    /**
     * Promise to set the data for a single user.
     * 
     * @param jid - identifies which user
     * @param data - the user data profile
     * @returns {Promise} - resolves to the user data
     */
    setUserData (jid, data) {
      return Promise.promisify(this.options.userStore.save.bind(this.options.userStore))(jid.bare().toString(), data)
        .then(() => data)
    }

    /**
     * Promise to get the data for a single user, and comes back undefined to 
     * allow botbuilder to set up the session
     * 
     * @param jid - identifies which user
     * @returns {Promise} - resolves to the user data
     */
    getSessionData (jid) {
      return Promise.promisify(this.options.sessionStore.get.bind(this.options.sessionStore))(jid.bare().toString())
        .then((userdata) => userdata)
    }

    /**
     * Promise to set the data for a single user.
     * 
     * @param jid - identifies which user
     * @param data - the user data profile
     * @returns {Promise} - resolves to the user data
     */
    setSessionData (jid, data) {
      return Promise.promisify(this.options.sessionStore.save.bind(this.options.sessionStore))(jid.bare().toString(), data)
        .then(() => data)
    }

    /**
     * Send a quick message outside of a dialog session.
     * 
     * @param to - JID of the target
     * @param message - body text for the message
     * @returns {Promise} - resolved on message receipt
     */
    send (to, message) {
      to = new XmppClient.JID(to.toString()).bare().toString()
      let id = uuid.v1()
      this.client.send(
        new XmppClient.Stanza('message', {id, to, type: 'chat'})
          .c('body')
          .t(message)
          .root()
          .c('x', {xmlns: 'http://hipchat.com'})
          .c('echo')
          .root()
          .c('time', {xmlns: 'urn:  xmpp:time'}).root()
      )
      return new Promise((resolve) => {
        this.resolvers[id] = resolve
      })
    }

    /**
     * Send a quick group message.
     * 
     * @param room - JID of the target room
     * @param message - body text for the message
     * @returns {Promise} - resolved on message receipt
     */
    sendChat (room, message) {
      let id = uuid.v1()
      this.client.send(
        new XmppClient.Stanza('message', {id, to: `${room.bare().toString()}/${this.profile.FN}`, type: 'groupchat'})
          .c('body')
          .t(message)
          .root()
          .c('x', {xmlns: 'http://hipchat.com'})
          .c('echo')
          .root()
          .c('time', {xmlns: 'urn:  xmpp:time'}).root()
      )
      return new Promise((resolve) => {
        this.resolvers[id] = resolve
      })
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
        this.maybeMessage(stanza) ||
        this.maybePresence(stanza) ||
        this.maybeInvite(stanza)
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
