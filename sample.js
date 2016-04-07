'use strict'

/*
pulling in from an environment
just make your own .env in the root

JABBER_UID=____@chat.hipchat.com
JABBER_PWD=____
JABBER_CHAT_HOST=chat.hipchat.com
JABBER_MUC_HOST=conf.hipchat.com
*/
require('dotenv').config()

const HipchatBot = require('./index')

let bot = new HipchatBot({
  uid: process.env.JABBER_UID,
  pwd: process.env.JABBER_PWD,
  chat_host: process.env.JABBER_CHAT_HOST,
  conference_host: process.env.JABBER_MUC_HOST
})

bot.add('/', function (session) {
  session.send('Hello World')
})

bot.listen()
