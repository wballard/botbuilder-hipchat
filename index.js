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
    constructor(options) {
      super(options)
      this.options = options
    }

    connect() {
      return new XmppClient({
        jid: this.options.uid,
        password: this.options.pwd,
        host: this.options.host
      })
    }

    // take 'iq' infor query messages and turn them into local state
    info(stanza) {
      let vCard = stanza.getChild('vCard')
      if (vCard) {
        this.profile = {}
        vCard.children.forEach((field) => this.profile[field.name] = field.getText())
      }
    }

    listen() {
      const client = this.connect()
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
            .map((stanza) => {
              if (Object.is(stanza.name, 'iq')) {
                this.info(stanza)
                return new XmppClient.Stanza('presence', {})
                  .c('show').t('chat').up()
                  .c('status').t(this.options.status || '')
              }

              console.log(JSON.stringify(stanza))
              return {}
            })
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
