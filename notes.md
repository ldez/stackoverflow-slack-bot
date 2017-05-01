
## Slack information

https://github.com/slackapi/node-slack-sdk

https://api.slack.com/methods

process.env.SLACK_API_TOKEN
https://xxxxx.slack.com/api/api.test



Slack call example:

```js
const payload = {
  text: "Hello!";
  username: "my bot";
  as_user: false;
  token: "mybottoken";
  channel: "#random";
};

const slackUrl = `${config.slack.apiBaseUrl}/chat.postMessage`;
request.post({ url: slackUrl, form: payload},
  function(error, response, body) {
    console.log(response);
  }
);
```
