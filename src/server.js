const bot = require('./bot');
const http = require('http');

const config = require('../config');
const port = config.serverPort || 80;

const requestHandler = (request, response) => {
  bot();
  response.end('Done!');
};

const server = http.createServer(requestHandler);

server.listen(port, (err) => {
  if (err) {
    return console.error('something bad happened', err);
  }

  console.log(`slackoverflow-bot is listening on ${port}`);
});
