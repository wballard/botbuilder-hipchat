'use strict'

const botframework = require('botbuilder')
const XmppClient = require('node-xmpp-client')
const Rx = require('rx')
const uuid = require('node-uuid')

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

    }

    /*
    Ask for a full profile by jid, come back with a promise for the full profile.
    */
    fullProfile (jid) {
      return new Promise((resolve) => {
        let id = `profile:${uuid.v1()}`
        this.resolvers[id] = resolve;
        this.backToServer.onNext(new XmppClient.Stanza('iq', {id: id, to: jid.bare().toString(), type: 'get'})
          .c('query', {xmlns: 'http://hipchat.com/protocol/profile'})
          .up().c('time', {xmlns: 'urn:xmpp:time'}))
      })
    }

    /*
    Build up a new connection with the options, and hook it to
    a reactive pipeline. The idea here is that if we get an interrupt, the
    program can exit and restart to reconnect.
    */
    listen () {
      // actual connection
      const client = new XmppClient({
        jid: this.options.uid,
        password: this.options.pwd,
        host: this.options.host
      })
      // reach back to the server, this is a 'republish point' where messages
      // being processed can generate additional observable messages
      let backToServer = this.backToServer = new Rx.Subject()
      this.directory = {}
      this.outgoing =
        backToServer
          // events making it out to here are stanzas to send along to the server
          .filter((isStanza) => isStanza instanceof XmppClient.Element)
          .do((stanza) => {
            console.error('transmit to server')
            client.send(stanza)
          })
          // fire up the subscription and start processing events
          .subscribe()

      this.incoming =
        Rx.Observable.merge(
          // online? go and get the profile for the bot
          Rx.Observable.fromEvent(client, 'online')
            .do(() => {
              backToServer.onNext(new XmppClient.Stanza('iq', { type: 'get' }).c('vCard', { xmlns: 'vcard-temp' }))
              backToServer.onNext(new XmppClient.Stanza('iq', { type: 'get' }).c('query', { xmlns: 'jabber:iq:roster' }))
              backToServer.onNext(new XmppClient.Stanza('presence', {}).c('show').t('chat').up().c('status').t(this.options.status || ''))
            })
          ,
          // keep alive with a nice empty message
          Rx.Observable.interval(30 * 1000)
            .do(() => backToServer.onNext(new XmppClient.Message()))
          ,
          // stanzas are messages from the server
          Rx.Observable.fromEvent(client, 'stanza')
            // informational queries come back and need to be parsed
            .do((stanza) => {
              if (Object.is(stanza.name, 'iq')) {
                // the vcard for the bot itself
                let vCard = stanza.getChild('vCard')
                if (vCard) {
                  this.profile = {}
                  vCard.children.forEach((field) => this.profile[field.name] = field.getText())
                }
                // may be a single person, look them up or make a profile record
                if ((stanza.attrs.id || '').indexOf('profile:') == 0) {
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
                    console.error(e)
                  }
                  console.error('hi', JSON.stringify(buddy))
                  this.directory[jid.bare().toString()] = buddy
                  let resolver = this.resolvers[stanza.attrs.id]
                  if (resolver) resolver(buddy)
                }
                // the directory, load it all up in a hash
                let query = stanza.getChild('query')
                if (query && query.getChildren('item')) {
                  (query.getChildren('item') || []).forEach((el) => {
                    let jid = new XmppClient.JID(el.attrs.jid)
                    let buddy = this.directory[jid.bare().toString()] || {}
                    buddy.jid = jid
                    buddy.name = el.attrs.name
                    buddy.mention_name = el.attrs.mention_name
                    console.error('hi', JSON.stringify(buddy))
                    this.directory[jid.bare().toString()] = buddy
                  })
                }
              }
            })
            // messages add to a dialog session, which triggers all the middleware
            // Message without body is probably a typing notification, but in any case
            // there is not much to say in response
            .do((stanza) => {
              if (Object.is(stanza.name, 'message') && Object.is(stanza.attrs.type, 'chat') && stanza.getChildText('body')) {
                // hoisting properties
                console.error(JSON.stringify(stanza))
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
                // observe the session, and forward sends back to the server after saving data
                // created first -- memory store appears to be synchronous, otherwise the 'send' is not
                // trapped
                Rx.Observable.fromEvent(ses, 'send')
                  .filter((msg) => msg)
                  .do((msg) => {
                    Rx.Observable.forkJoin(
                      Rx.Observable.fromNodeCallback(this.options.sessionStore.save, this.options.sessionStore)(stanza.from, ses.sessionState),
                      Rx.Observable.fromNodeCallback(this.options.userStore.save, this.options.userStore)(stanza.from, ses.userData),
                      (sessionData, userData) => {
                        console.error('transmit')
                        let backToWho = this.directory[stanza.from.bare().toString()]
                        backToServer.onNext(new XmppClient.Stanza('message', {id: uuid.v1(), to: stanza.from, type: 'chat'})
                          .c('body').t(msg.text).root().c('time', {xmlns: 'urn:xmpp:time'}))
                      }
                    ).subscribe()
                  }).subscribe()
                // observe session and user data, then dispatch a message
                Rx.Observable.forkJoin(
                  Rx.Observable.fromNodeCallback(this.options.sessionStore.get, this.options.sessionStore)(stanza.from),
                  Rx.Observable.fromNodeCallback(this.options.userStore.get, this.options.userStore)(stanza.from),
                  (sessionData, userData) => {
                    console.error('dispatch')
                    ses.userData = userData || {}
                    // pull in the user from the directory
                    ses.userData.identity = this.directory[stanza.from.bare().toString()]
                    ses.dispatch(sessionData, stanza)
                  }
                ).subscribe()
              }
            }
          )
        )
          // fire up the subscription and start processing events
          .subscribe()
    }

}
