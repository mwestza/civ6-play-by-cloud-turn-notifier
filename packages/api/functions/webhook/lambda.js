import 'source-map-support/register'
import fetch from 'node-fetch'
import { createLogger, format, transports } from 'winston'
import middy from '@middy/core'
import sqsPartialBatchFailureMiddleware from '@middy/sqs-partial-batch-failure'
// import sampleLogging from '@dazn/lambda-powertools-middleware-sample-logging'
// import captureCorrelationIds from '@dazn/lambda-powertools-middleware-correlation-ids'
// import logTimeout from '@dazn/lambda-powertools-middleware-log-timeout'
import '../../aws'
import Game from '../../models/Game'

const logger = createLogger({
  level: 'debug',
  format: format.combine(
    format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss',
    }),
    format.errors({ stack: true }),
    format.json(),
  ),
  transports: new transports.Console({
    handleExceptions: true,
    handleRejections: true,
  }),
})
let log = logger.child({ awsRequestId: null })
export const MESSAGE_TEMPLATE = `{{playerName}}, it's your turn.
Turn: {{turnNumber}}
Game: {{gameName}}`
const BOT_USERNAME = 'Civ6 Turnbot'
const AVATAR_URL = 'http://www.megabearsfan.net/image.axd/2017/8/CivVI-JohnCurtin_250x250.png'

export async function webhookHandler(event, context) {
  log = logger.child({ awsRequestId: context.awsRequestId })
  log.debug('WEBHOOK_HANDLER_CALLED_WITH', { event })

  const { Records } = event

  if (!Records || !Array.isArray(Records)) {
    throw new Error(`Lambda didn't receive a \`Records\` array in the \`event\` object. Received: ${Records}.`)
  }

  const recordPromises = Records.map(processMessage)

  return Promise.allSettled(recordPromises)
}

async function processMessage(record, index) {
  log.debug('PROCESS_MESSAGE_CALLED_WITH', { index, record })

  const {
    messageId,
    body,
    messageAttributes,
  } = record

  if (!messageId) {
    throw new Error(`Records[${index}] is missing \`messageId\`.`)
  }

  // TODO: Check if `messageId` has been processed

  if (!body) {
    throw new Error(`Records[${index}].body is missing.`)
  }

  const bodyJson = JSON.parse(body)

  log.debug('PROCESS_MESSAGE_MESSAGE_BODY_JSON', bodyJson)

  const {
    gameId,
    botUsername,
    avatarUrl,
    messageTemplate,
  } = getMessageAttributeStringValues({ messageAttributes })

  log.debug('PROCESS_MESSAGE_MESSAGE_ATTRIBUTE_STRING_VALUES', {
    gameId,
    botUsername,
    avatarUrl,
    messageTemplate,
  })

  if (!gameId) {
    throw new Error(`\`Records[${index}].messageAttributes.gameId\` is missing.`)
  }

  const {
    value1: gameName,
    value2: playerName,
    value3: turnNumber,
  } = bodyJson

  log.debug('PROCESS_MESSAGE_VALUES_FROM_CIV', {
    gameName,
    playerName,
    turnNumber,
  })

  const game = await Game.get(gameId)

  if (!game) {
    throw new Error(`No game found with id: ${gameId}`)
  }

  const discordWebhookUrl = game.get('discordWebhookUrl')
  const players = game.get('players')

  log.debug('PROCESS_MESSAGE_GAME_VALUES', { discordWebhookUrl, players })

  const messageFromTemplate = getMessageFromTemplate({
    messageTemplate,
    gameName,
    playerName,
    turnNumber,
    players,
  })

  log.debug('PROCESS_MESSAGE_MESSAGE_FROM_TEMPLATE', { messageFromTemplate })

  const targetWebhookBody = {
    username: botUsername,
    avatar_url: avatarUrl,
    content: messageFromTemplate,
    /*
    // TODO: Add Civ6 memes
    "embeds": [
      {
        "image": {
          "url": avatarUrl
        }
      }
    ]
    */
  }

  log.debug('PROCESS_MESSAGE_DISCORD_REQUEST_BODY', { targetWebhookBody })

  const response = await fetch(discordWebhookUrl, {
    body: JSON.stringify(targetWebhookBody),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  })

  const responseText = await response.text()

  log.debug('PROCESS_MESSAGE_RESPONSE_TEXT', { responseText })

  if (!response.ok) {
    throw new Error(`HTTP response not ok: ${response.status} ${responseText}`)
  }

  return responseText
}

export function getMessageFromTemplate({
  messageTemplate,
  gameName,
  playerName,
  turnNumber,
  players = {},
  playerNameOrDiscordUserId = getDiscordUserId({
    players,
    playerName,
  }),
}) {
  return messageTemplate
    .replace(/{{gameName}}/g, gameName)
    .replace(/{{playerName}}/g, playerNameOrDiscordUserId)
    .replace(/{{turnNumber}}/g, turnNumber)
}

export function getDiscordUserId({
  players = {},
  playerName,
}) {
  const discordUserId = players && players[playerName] && players[playerName].discordUserId

  // Default to using playerName if no discordUserId is set, or discordUserId is invalid (non-numerical)
  let playerNameOrDiscordUserId = playerName

  if (discordUserId) {
    // correct format for @ing someone on Discord
    if (/^<@\d+>$/.test(discordUserId)) playerNameOrDiscordUserId = discordUserId

    // includes @ prefix only: wrap in <>
    else if (/^@\d+$/.test(discordUserId)) playerNameOrDiscordUserId = `<${discordUserId}>`

    // account number only: wrap in <@>
    else if (/^\d+$/.test(discordUserId)) playerNameOrDiscordUserId = `<@${discordUserId}>`
  }

  return playerNameOrDiscordUserId
}

function getMessageAttributeStringValues({ messageAttributes }) {
  const messageAttributeValues = {
    botUsername: BOT_USERNAME,
    avatarUrl: AVATAR_URL,
    messageTemplate: MESSAGE_TEMPLATE,
  }

  Object.entries(messageAttributes).forEach(([key, value]) => {
    messageAttributeValues[key] = value.stringValue
  })

  return messageAttributeValues
}
export const webhookHandlerMiddy = middy(webhookHandler)

webhookHandlerMiddy
  // .use(captureCorrelationIds({
  //   sampleDebugLogRate: parseFloat(process.env.SAMPLE_DEBUG_LOG_RATE || '0.01'),
  // }))
  // .use(sampleLogging({
  //   sampleRate: parseFloat(process.env.SAMPLE_DEBUG_LOG_RATE || '0.01'),
  // }))
  // .use(logTimeout())
  .use(sqsPartialBatchFailureMiddleware())
