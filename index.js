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
      let backToServer = new Rx.Subject()
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
            // informational queries come back with an online status
            .do((stanza) => {
              if (Object.is(stanza.name, 'iq')) {
                // the vcard for the bot itself
                let vCard = stanza.getChild('vCard')
                if (vCard) {
                  this.profile = {}
                  vCard.children.forEach((field) => this.profile[field.name] = field.getText())
                }
                // the directory, load it all up in a hash
                let query = stanza.getChild('query')
                if (query) {
                  (query.getChildren('item') || []).forEach((el) => {
                    let buddy = {
                      jid: new XmppClient.JID(el.attrs.jid),
                      name: el.attrs.name,
                      // name used to @mention this user
                      mention_name: el.attrs.mention_name
                    }
                    this.directory[buddy.jid.toString()] = buddy
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
                  .do((msg) => {
                    console.error(JSON.stringify(msg))
                    Rx.Observable.forkJoin(
                      Rx.Observable.fromNodeCallback(this.options.sessionStore.save, this.options.sessionStore)(stanza.from, ses.sessionState),
                      Rx.Observable.fromNodeCallback(this.options.userStore.save, this.options.userStore)(stanza.from, ses.userData),
                      (sessionData, userData) => {
                        console.error('transmit')
                        backToServer.onNext(new XmppClient.Stanza('message', {to: stanza.from, type: 'chat'})
                          .c('body').t(msg.text))
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
