const http = require('http');
const { v4: uuidV4 } = require('uuid');
const express = require('express');
const morgan = require('morgan');
const { Server } = require('socket.io');

require('dotenv').config();

const { TunnelRequest, TunnelResponse } = require('./lib');

const app = express();
const httpServer = http.createServer(app);
const webTunnelPath = '/$web_tunnel';
const io = new Server(httpServer, {
  path: webTunnelPath,
});

let tunnelSockets = {};
// creates map of applicationName<->ApiKey
let apiKeyMap = {};

io.use((socket, next) => {
  const connectHost = socket.handshake.headers.host;
  if (!socket.handshake.query || !socket.handshake.query['appName']){
    next(new Error('Authentication error, missing application name or authentication token'));
  }
  const appName = socket.handshake.query['appName'];
  
  if (tunnelSockets[appName]) {
    return next(new Error(`${appName} app running on host ${connectHost} has a existing connection`));
  }
  if (!socket.handshake.auth || !socket.handshake.auth.token){
    next(new Error('Authentication error , missing application name or authentication token'));
  }
  
  if(!apiKeyMap[appName]) {
    next(new Error(`Authentication error, ${appName} application authentication details are not configured on the server`));
  }
  next();

});

io.on('connection', (socket) => {
  const connectHost = socket.handshake.headers.host;
  const appName = socket.handshake.query['appName'];
  tunnelSockets[appName] = socket;
  console.log(`client connected at ${connectHost} with appname ${appName}`);
  const onMessage = (message) => {
    if (message === 'ping') {
      socket.send('pong');
    }
  }
  const onDisconnect = (reason) => {
    console.log('client disconnected: ', reason);
    delete tunnelSockets[appName];
    socket.off('message', onMessage);
  };
  socket.on('message', onMessage);
  socket.once('disconnect', onDisconnect);
});

app.use(morgan('tiny'));

function getReqHeaders(req) {
  const encrypted = !!(req.isSpdy || req.connection.encrypted || req.connection.pair);
  const headers = { ...req.headers };
  const url = new URL(`${encrypted ? 'https' : 'http'}://${req.headers.host}`);
  const forwardValues = {
    for: req.connection.remoteAddress || req.socket.remoteAddress,
    port: url.port || (encrypted ? 443 : 80),
    proto: encrypted ? 'https' : 'http',
  };
  ['for', 'port', 'proto'].forEach((key) => {
    const previousValue = req.headers[`x-forwarded-${key}`] || '';
    headers[`x-forwarded-${key}`] =
      `${previousValue || ''}${previousValue ? ',' : ''}${forwardValues[key]}`;
  });
  headers['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers.host || '';
  return headers;
}

app.use('/:appName', (req, res) => {
  const applicationName = req.params["appName"];
  const tunnelSocket = tunnelSockets[applicationName];
  if (!tunnelSocket) {
    res.status(404);
    res.send('Not Found');
    return;
  }
  const requestId = uuidV4();
  const tunnelRequest = new TunnelRequest({
    socket: tunnelSocket,
    requestId,
    request: {
      method: req.method,
      headers: getReqHeaders(req),
      path: req.url,
    },
  });
  const onReqError = (e) => {
    tunnelRequest.destroy(new Error(e || 'Aborted'));
  }
  req.once('aborted', onReqError);
  req.once('error', onReqError);
  req.pipe(tunnelRequest);
  req.once('finish', () => {
    req.off('aborted', onReqError);
    req.off('error', onReqError);
  });
  const tunnelResponse = new TunnelResponse({
    socket: tunnelSocket,
    responseId: requestId,
  });
  const onRequestError = () => {
    tunnelResponse.off('response', onResponse);
    tunnelResponse.destroy();
    res.status(502);
    res.end('Request error');
  };
  const onResponse = ({ statusCode, statusMessage, headers }) => {
    tunnelRequest.off('requestError', onRequestError)
    res.writeHead(statusCode, statusMessage, headers);
  };
  tunnelResponse.once('requestError', onRequestError)
  tunnelResponse.once('response', onResponse);
  tunnelResponse.pipe(res);
  const onSocketError = () => {
    res.off('close', onResClose);
    res.end(500);
  };
  const onResClose = () => {
    tunnelSocket.off('disconnect', onSocketError);
  };
  tunnelSocket.once('disconnect', onSocketError)
  res.once('close', onResClose);
});

function createSocketHttpHeader(line, headers) {
  return Object.keys(headers).reduce(function (head, key) {
    var value = headers[key];

    if (!Array.isArray(value)) {
      head.push(key + ': ' + value);
      return head;
    }

    for (var i = 0; i < value.length; i++) {
      head.push(key + ': ' + value[i]);
    }
    return head;
  }, [line])
  .join('\r\n') + '\r\n\r\n';
}

httpServer.on('upgrade', (req, socket, head) => {
  if (req.url.indexOf(webTunnelPath) === 0) {
    return;
  }
  console.log(`WS ${req.url}`);
  const appName = socket.handshake.query['appName'];
  // proxy websocket request
  const tunnelSocket = tunnelSockets[appName];
  if (!tunnelSocket) {
    return;
  }
  if (head && head.length) socket.unshift(head);
  const requestId = uuidV4();
  const tunnelRequest = new TunnelRequest({
    socket: tunnelSocket,
    requestId,
    request: {
      method: req.method,
      headers: getReqHeaders(req),
      path: req.url,
    },
  });
  req.pipe(tunnelRequest);
  const tunnelResponse = new TunnelResponse({
    socket: tunnelSocket,
    responseId: requestId,
  });
  const onRequestError = () => {
    tunnelResponse.off('response', onResponse);
    tunnelResponse.destroy();
    socket.end();
  };
  const onResponse = ({ statusCode, statusMessage, headers, httpVersion }) => {
    tunnelResponse.off('requestError', onRequestError);
    if (statusCode) {
      socket.once('error', (err) => {
        console.log(`WS ${req.url} ERROR`);
        // ignore error
      });
      // not upgrade event
      socket.write(createSocketHttpHeader(`HTTP/${httpVersion} ${statusCode} ${statusMessage}`, headers));
      tunnelResponse.pipe(socket);
      return;
    }
    const onSocketError = (err) => {
      console.log(`WS ${req.url} ERROR`);
      socket.off('end', onSocketEnd);
      tunnelSocket.off('disconnect', onTunnelError);
      tunnelResponse.destroy(err);
    };
    const onSocketEnd = () => {
      console.log(`WS ${req.url} END`);
      socket.off('error', onSocketError);
      tunnelSocket.off('disconnect', onTunnelError);
      tunnelResponse.destroy();
    };
    const onTunnelError = () => {
      socket.off('error', onSocketError);
      socket.off('end', onSocketEnd);
      socket.end();
      tunnelResponse.destroy();
    };
    socket.once('error', onSocketError);
    socket.once('end', onSocketEnd);
    tunnelSocket.once('disconnect', onTunnelError);
    socket.write(createSocketHttpHeader('HTTP/1.1 101 Switching Protocols', headers));
    tunnelResponse.pipe(socket).pipe(tunnelResponse);
  }
  tunnelResponse.once('requestError', onRequestError)
  tunnelResponse.once('response', onResponse);
});
// creates map of API<->ApiKey
// APIKEYS=appName1:apiKey1,appName2:apiKey2
if ( process.env.APIKEYS) {
  process.env.APIKEYS.split(",").forEach( function(item) {
    let values = item.split(":");
    apiKeyMap[values[0]] = values[1];
  })
}
httpServer.listen(process.env.PORT || 3000);
console.log(`app start at http://localhost:${process.env.PORT || 3000}`);
