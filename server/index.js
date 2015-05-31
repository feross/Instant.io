var compress = require('compression')
var debug = require('debug')('instant')
var express = require('express')
var fs = require('fs')
var http = require('http')
var https = require('https')
var jade = require('jade')
var parallel = require('run-parallel')
var path = require('path')
var url = require('url')
var twilio = require('twilio')

var config = require('../config')
var useTwilio
var secret
try {
  secret = require('../secret')
  useTwilio=true
}
catch(e) {
  useTwilio=false
}
var util = require('./util')

var app = express()
var httpServer = http.createServer(app)

var useHttps=fs.existsSync(__dirname + '/../secret/instant.io.key') && fs.existsSync(__dirname + '/../secret/instant.io.chained.crt');
var httpsServer
if(useHttps) httpsServer = https.createServer({
  key: fs.readFileSync(__dirname + '/../secret/instant.io.key'),
  cert: fs.readFileSync(__dirname + '/../secret/instant.io.chained.crt')
}, app)

util.upgradeLimits()

// Templating
app.set('views', __dirname + '/views')
app.set('view engine', 'jade')
app.set('x-powered-by', false)
app.engine('jade', jade.renderFile)

app.use(compress())

app.use(function (req, res, next) {
  // Force SSL
  if (config.isProd && req.protocol !== 'https') {
    return res.redirect('https://' + (req.hostname || 'instant.io') + req.url)
  }

  // Redirect www to non-www
  if (config.isProd && req.hostname === 'www.instant.io') {
    return res.redirect('https://instant.io' + req.url)
  }

  // Strict transport security (to prevent MITM attacks on the site)
  if (config.isProd) {
    res.header('Strict-Transport-Security', 'max-age=31536000')
  }

  // Add cross-domain header for fonts, required by spec, Firefox, and IE.
  var extname = path.extname(url.parse(req.url).pathname)
  if (['.eot', '.ttf', '.otf', '.woff', '.woff2'].indexOf(extname) >= 0) {
    res.header('Access-Control-Allow-Origin', '*')
  }

  // Prevents IE and Chrome from MIME-sniffing a response. Reduces exposure to
  // drive-by download attacks on sites serving user uploaded content.
  res.header('X-Content-Type-Options', 'nosniff')

  // Prevent rendering of site within a frame.
  res.header('X-Frame-Options', 'DENY')

  // Enable the XSS filter built into most recent web browsers. It's usually
  // enabled by default anyway, so role of this headers is to re-enable for this
  // particular website if it was disabled by the user.
  res.header('X-XSS-Protection', '1; mode=block')

  // Force IE to use latest rendering engine or Chrome Frame
  res.header('X-UA-Compatible', 'IE=Edge,chrome=1')

  next()
})

app.use(express.static(path.join(__dirname, '../static')))

app.get('/', function (req, res) {
  res.render('index')
})

// Fetch new ice_servers from twilio token regularly
var iceServers
var twilioClient
if(useTwilio)
  twilioClient = twilio(secret.twilio.accountSid, secret.twilio.authToken)

function updateIceServers () {
  twilioClient.tokens.create({}, function (err, token) {
    if (err) return error(err)
    if (!token.ice_servers) {
      return error(new Error('twilio response ' + token + ' missing ice_servers'))
    }

    iceServers = token.ice_servers
      .filter(function (server) {
        var urls = server.urls || server.url
        return urls && !/^stun:/.test(urls)
      })
    iceServers.unshift({ url: 'stun:23.21.150.121' })

    // Support new spec (`RTCIceServer.url` was renamed to `RTCIceServer.urls`)
    iceServers = iceServers.map(function (server) {
      if (server.urls === undefined) server.urls = server.url
      return server
    })
  })
}

if(useTwilio) {
  setInterval(updateIceServers, 60 * 60 * 4 * 1000).unref()
  updateIceServers()
}

app.get('/rtcConfig', function (req, res) {
  if (!iceServers) res.status(404).send({ iceServers: [] })
  else res.send({ iceServers: iceServers })
})

app.get('*', function (req, res) {
  res.status(404).render('error', { message: '404 Not Found' })
})

// error handling middleware
app.use(function (err, req, res, next) {
  error(err)
  res.status(500).render('error', { message: err.message || err })
})

var listenFunctions=[
  function (cb) {
    httpServer.listen(config.ports.http, config.host, cb)
  }];
if(useHttps)
  listenFunctions.push(function (cb) {
  httpsServer.listen(config.ports.https, config.host, cb)
});

parallel(listenFunctions, function (err) {
  if (err) throw err
  debug('listening on port %s', JSON.stringify(config.ports))
  util.downgradeUid()
})

function error (err) {
  console.error(err.stack || err.message || err)
}
