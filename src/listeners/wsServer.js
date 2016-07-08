import path from 'path';
import http from 'http';
import express from 'express';
import socketio from 'socket.io';
import Promise from 'bluebird';
import chalk from 'chalk';
import { addDefaults } from 'timm';
import { throttle } from '../vendor/lodash';
import filters from '../gral/filters';
import { WS_NAMESPACE } from '../gral/constants';

const DEFAULT_CONFIG = {
  port: 8090,
  throttle: 200,
  authenticate: null
};

const LOG_SRC = 'storyboard';
const SOCKET_ROOM = 'authenticated';

// -----------------------------------------
// Listener
// -----------------------------------------
function WsServerListener(config, { hub, mainStory }) {
  this.type = 'WS_SERVER';
  this.config = config;
  this.hub = hub;
  this.mainStory = mainStory;
  this.ioStandaloneServer = null;
  this.ioStandaloneNamespace = null;
  this.ioServerAdaptor = null;
  // Short buffer for records to be broadcast
  // (accumulated during the throttle period)
  this.bufBroadcast = [];
  const { throttle: throttlePeriod } = config;
  if (throttlePeriod) {
    this.socketBroadcast = throttle(this.socketBroadcast, throttlePeriod).bind(this);
  }
}

WsServerListener.prototype.init = function() {
  const { config, mainStory } = this;
  const { port } = config;

  // Launch stand-alone log server
  if (port != null) {
    const httpInitError = logError(mainStory, 
      `Error initialising standalone server logs on port ${chalk.cyan(port)}`);
    try {
      const expressApp = express();
      expressApp.use(express["static"](path.join(__dirname, '../../serverLogsApp')));
      const httpServer = http.createServer(expressApp);
      httpServer.on('error', httpInitError);
      httpServer.on('listening', () => {
        const tmpPort = httpServer.address().port;
        mainStory.info(LOG_SRC, `Server logs available on port ${chalk.cyan(tmpPort)}`);
      });
      this.ioStandaloneServer = socketio(httpServer);
      this.ioStandaloneNamespace = this.ioStandaloneServer.of(WS_NAMESPACE);
      this.ioStandaloneNamespace.on('connection', socket => this.socketConnect(socket));
      httpServer.listen(port);
    } catch (err) { httpInitError(err); }
  }

  // If a main application server is also provided, 
  // launch another log server on the same application port
  if (config.socketServer) {
    this.ioServerAdaptor = config.socketServer.of(WS_NAMESPACE);
  } else if (config.httpServer) {
    this.ioServerAdaptor = socketio(config.httpServer).of(WS_NAMESPACE);
  }
  if (this.ioServerAdaptor) {
    this.ioServerAdaptor.on('connection', socket => this.socketConnect(socket));
    const httpInitError = logError(mainStory, `Error initialising log server adaptor`);
    try {
      const httpServer = this.ioServerAdaptor.server.httpServer;
      httpServer.on('error', httpInitError);
      httpServer.on('listening', () => {
        const tmpPort = httpServer.address().port;
        mainStory.info(LOG_SRC,
          `Server logs available through main HTTP server on port ${chalk.cyan(tmpPort)}`);
      });
    } catch (err) { httpInitError(err); }
  }
};

WsServerListener.prototype.tearDown = function() {
  if (this.ioStandaloneServer) {
    this.ioStandaloneServer.close();
    this.ioStandaloneServer = null;
  }
  this.ioStandaloneNamespace = null;
  if (this.ioServerAdaptor) {
    if (this.ioServerAdaptor.close) this.ioServerAdaptor.close();
    this.ioServerAdaptor = null;
  }
};

WsServerListener.prototype.socketConnect = function(socket) {
  socket.sbAuthenticated = (this.config.authenticate == null);
  if (socket.sbAuthenticated) socket.join(SOCKET_ROOM);
  socket.on('MSG', msg => this.socketRx(socket, msg));
};

WsServerListener.prototype.socketRx = function(socket, msg) {
  const { type, data } = msg;
  const { mainStory, hub, config } = this;
  let newFilter;
  // let rsp;
  switch (type) {
    case 'LOGIN_REQUEST':
      this.socketLogin(socket, msg);
      break;
    case 'LOG_OUT':
      this.socketLogout(socket);
      break;
    case 'LOGIN_REQUIRED_QUESTION':
      this.socketTx(socket, {
        type: 'LOGIN_REQUIRED_RESPONSE',
        result: 'SUCCESS',
        data: { fLoginRequired: config.authenticate != null },
      });
      break;
    // case 'BUFFERED_RECORDS_REQUEST':
    //   rsp = { type: 'BUFFERED_RECORDS_RESPONSE' };
    //   if socket.sbAuthenticated {
    //     rsp.result = 'SUCCESS';
    //     rsp.data = hub.getBufferedRecords();
    //   } else {
    //     rsp.result = 'ERROR';
    //     rsp.error = 'AUTH_REQUIRED';
    //   }
    //   this.socketTx(socket, rsp);
    case 'GET_SERVER_FILTER':
    case 'SET_SERVER_FILTER':
      if (type === 'SET_SERVER_FILTER') {
        newFilter = msg.data;
        filters.config(newFilter);
        process.nextTick(() => {
          mainStory.info(LOG_SRC, `Server filter changed to: ${chalk.cyan.bold(newFilter)}`);
        });
      }
      this.socketTx(socket, {
        type: 'SERVER_FILTER',
        result: 'SUCCESS',
        data: { filter: filters.getConfig() },
      });
      break;
    case 'UPLOAD_RECORDS':
      process.nextTick(() => {
        msg.data.forEach(record => { hub.emit(record); });
      });
      break;
    default:
      process.nextTick(() => {
        mainStory.warn(LOG_SRC, `Unknown message type '${type}'`);
      });
  }
};

WsServerListener.prototype.socketLogin = function(socket, msg) {
  const { mainStory, hub, config } = this;
  const { authenticate } = config;
  const { data: credentials } = msg;
  const { login } = credentials;
  const fPreAuthenticated = socket.sbAuthenticated || authenticate == null;
  Promise.resolve(fPreAuthenticated || authenticate(credentials))
  .then(fAuthValid => {
    const rsp = { type: 'LOGIN_RESPONSE' };
    if (fAuthValid) {
      rsp.result = 'SUCCESS';
      socket.sbAuthenticated = true;
      socket.join(SOCKET_ROOM);
      const bufferedRecords = hub.getBufferedRecords();
      rsp.data = { login, bufferedRecords };
      process.nextTick(() => {
        mainStory.info(LOG_SRC, `User '${login}' authenticated successfully`);
        // mainStory.debug(LOG_SRC, `Piggybacked ${chalk.cyan(bufferedRecords.length)} records`);
      });
    } else {
      rsp.result = 'ERROR';
      process.nextTick(() => {
        mainStory.warn(LOG_SRC, `User '${login}' authentication failed`);
      });
    }
    this.socketTx(socket, rsp);
  });
};

WsServerListener.prototype.socketLogout = function(socket) {
  const { authenticate } = this.config;
  if (authenticate != null) {
    socket.sbAuthenticated = false;
    socket.leave(SOCKET_ROOM);
  }
};

WsServerListener.prototype.socketTx = function(socket, msg) {
  socket.emit('MSG', msg);
};


WsServerListener.prototype.addToBroadcastBuffer = function(record) {
  this.bufBroadcast.push(record);
};

// Send records (buffered since the last call to this function)
// both through the standalone server and the piggybacked one
WsServerListener.prototype.socketBroadcast = function() {
  const { ioStandaloneNamespace, ioServerAdaptor } = this;
  const msg = { type: 'RECORDS', data: this.bufBroadcast };
  if (ioStandaloneNamespace) ioStandaloneNamespace.to(SOCKET_ROOM).emit('MSG', msg);
  if (ioServerAdaptor) ioServerAdaptor.to(SOCKET_ROOM).emit('MSG', msg);
  this.bufBroadcast.length = 0;
};

// -----------------------------------------
// Main processing function
// -----------------------------------------
WsServerListener.prototype.process = function(record) {
  this.addToBroadcastBuffer(record);
  this.socketBroadcast(); // may be throttled
};

// -----------------------------------------
// Helpers
// -----------------------------------------
const logError = (mainStory, msg) => err => {
  mainStory.error(LOG_SRC, msg, { attach: err });
};

// -----------------------------------------
// API
// -----------------------------------------
const create = (userConfig, context) =>
  new WsServerListener(addDefaults(userConfig, DEFAULT_CONFIG), context);

export default create;