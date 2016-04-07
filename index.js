'use strict'

const botframework = require('botbuilder')
const XmppClient = require('node-xmpp-client')
const Rx = require('rx')

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
      this.options.sessionStore = new botframework.MemoryStorage()
    }

    connect () {
      return new XmppClient({
        jid: this.options.uid,
        password: this.options.pwd,
        host: this.options.host
      })
    }

    listen () {
      const client = this.connect()
      let backToServer = new Rx.Subject()
      this.subscription =
        Rx.Observable.merge(
          // online? go and get the profile for the bot
          Rx.Observable.fromEvent(client, 'online')
            .map(() => new XmppClient.Stanza('iq', { type: 'get' })
              .c('vCard', { xmlns: 'vcard-temp' }))
          ,
          // keep alive with a nice empty message
          Rx.Observable.interval(30 * 1000)
            .map(() => new XmppClient.Message())
          ,
          // stanzas are messages from the server
          Rx.Observable.fromEvent(client, 'stanza')
            .do((stanza) => {
              // informational queries come back with an online status
              if (Object.is(stanza.name, 'iq')) {
                let vCard = stanza.getChild('vCard')
                if (vCard) {
                  this.profile = {}
                  vCard.children.forEach((field) => this.profile[field.name] = field.getText())
                }
                backToServer.onNext(
                  new XmppClient.Stanza('presence', {})
                    .c('show').t('chat').up()
                    .c('status').t(this.options.status || ''))
              }
              // messages add to a dialog session
              // Message without body is probably a typing notification, but in any case
              // there is not much to say in response
              if (Object.is(stanza.name, 'message') && Object.is(stanza.attrs.type, 'chat') && stanza.getChildText('body')) {
                stanza.to = new XmppClient.JID(stanza.attrs.to)
                stanza.from = new XmppClient.JID(stanza.attrs.from)
                stanza.text = stanza.getChildText('body')
                let ses = new botframework.Session({
                  localizer: this.options.localizer,
                  dialogs: this,
                  dialogId: this.options.defaultDialogId,
                  dialogArgs: {}
                })
                // precreated since the memory store isn't actually async, this is where
                // it is time to send a message back up to the server after we make sure the
                // session state is all updated
                ses.on('send', (msg) => {
                  this.options.sessionStore.get(stanza.from, (err, data) => {
                    backToServer.onNext(new XmppClient.Stanza('message', {to: stanza.from, type: 'chat'})
                      .c('body').t(msg.text))
                  })
                })
                this.options.sessionStore.get(stanza.from, (err, data) => {
                  if (err)
                    ses.dispatch(null, stanza)
                  else
                    ses.dispatch(data, stanza)
                })
              }
            })
            // all processed, do not forward stanzas from the server, anything to go back to the server
            // needs to be `backToServer.onNext`
            .filter(() => false)
          ,
          backToServer
        )
          // events making it out to here are stanzas to send along to the server
          .filter((isStanza) => isStanza instanceof XmppClient.Element)
          .do((stanza) => {
            console.error('-->')
            client.send(stanza)
          })
          // fire up the subscription and start processing events
          .subscribe()
    }

}
