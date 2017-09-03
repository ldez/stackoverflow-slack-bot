const fs = require('fs');
const request = require('request');
const Entities = require('html-entities').AllHtmlEntities;
const config = require('../config');

const entities = new Entities();


const questionURL = `${config.so.apiBaseURL}/questions?order=desc&sort=activity&tagged=${encodeURIComponent(config.tags)}&site=stackoverflow`;

module.exports = function start() {
  const currentTime = Math.round(Date.now() / 1000);
  const lastTime = getLastTime();
  getJSON(questionURL, processQuestions, handleError);

  function processQuestions(questions) {
    const soActivities = questions.items
      .filter(question => question.last_activity_date > lastTime)
      .map(function(question) {
        return {
          id: question.question_id,
          title: entities.decode(question.title),
          activity: question.last_activity_date,
          creationDate: question.creation_date,
          link: question.link,
          actions: []
        };
      })
      .reduce((activities, activity) => {
        activities[activity.id] = activity;
        return activities;
      }, {});

    console.log(`quota_max: ${questions.quota_max} quota_remaining: ${questions.quota_remaining}`);
    processTimeline(soActivities);
  }

  function processTimeline(soActivities) {
    if (Object.keys(soActivities).length) {
      const questionIds = Object.keys(soActivities).join(';');
      const timelineURL = `${config.so.apiBaseURL}/questions/${questionIds}/timeline?site=stackoverflow`;
      getJSON(timelineURL, (timeline) => pTimeline(timeline, soActivities), handleError);
    }
  }

  function pTimeline(timeline, soActivities) {
    const checkQuestions = {};

    timeline.items
      .filter(tl => tl.creation_date > lastTime)
      .forEach(function(tl) {
        const soActivity = soActivities[tl.question_id];
        switch (tl.timeline_type) {
          case 'question':
            soActivity.actions.push(historyEvent(tl, 'asked this question.', config.slack.icons.askedQuestion));
            break;
          case 'revision':
            if (tl.question_id == tl.post_id) {
              soActivity.actions.push(historyEvent(tl, 'revised the question.', config.slack.icons.revisedQuestion));
            } else {
              soActivity.actions.push(historyEvent(tl, 'revised an answer.', config.slack.icons.revisedAnswer, getAnswerLink(tl.post_id)));
            }
            break;
          case 'accepted_answer':
            soActivity.actions.push(historyEvent(tl, 'answer was accepted.', config.slack.icons.answerAccepted, getAnswerLink(tl.post_id)));
            break;
          case 'answer':
            checkQuestions[tl.question_id] = checkQuestions[tl.question_id] || [];
            checkQuestions[tl.question_id].push(tl.creation_date);
            break;
          case 'comment':
            soActivity.actions.push(historyEvent(tl, 'made a comment.', config.slack.icons.comment, getCommentLink(tl.question_id, tl.post_id, tl.comment_id)));
            break;
          case 'unaccepted_answer':
          case 'post_state_changed':
          case 'vote_aggregate':
          default:
            break;
        }
      });

    // now we handle new questions since they are not present in the stream with an id.
    if (Object.keys(checkQuestions).length > 0) {
      processAnswers(soActivities, checkQuestions)
    } else {
      sendToSlack(soActivities);
    }
  }

  function processAnswers(soActivities, checkQuestions) {
    const questionIds = Object.keys(checkQuestions).join(';');
    const answerURL = `${config.so.apiBaseURL}/questions/${questionIds}/answers?fromdate=${lastTime}&todate=${currentTime}&order=desc&sort=activity&site=stackoverflow`;
    getJSON(answerURL, (answers) => pAnswers(answers, soActivities, checkQuestions), handleError);
  }

  function pAnswers(answers, soActivities, checkQuestions) {
    answers.items
      .forEach(function(answer) {
        const soActivity = soActivities[answer.question_id];
        if (checkQuestions[answer.question_id].indexOf(answer.creation_date) > -1) {
          soActivity.actions.push(historyEvent(answer, 'posted an answer.', config.slack.icons.postedAnswer, getAnswerLink(answer.answer_id)));
        }
      });

    sendToSlack(soActivities);
  }

  function makeSlackMessage(soActivities) {
    let slackMessage = `${config.slack.icons.newActivity} New StackOverflow activity on the <http://stackoverflow.com/questions/tagged/${config.tags.replace(';', '|')} Tag>:\n\n`;

    slackMessage += Object.keys(soActivities)
      .map(key => soActivities[key])
      .map(function(soActivity) {
        const message = [];

        const creationDate = new Date();
        creationDate.setTime(soActivity.creationDate * 1000);

        message.push(`${config.slack.icons.topic} <${soActivity.link}|${soActivity.title}>: _${creationDate}_`);

        const actionsText = soActivity.actions
          .sort((a, b) => a.when - b.when)
          .map(function(action) {
            let actionText = `\t\t\t ${action.emoij} ${action.who} `;
            if (action.link) {
              actionText += `<${action.link}|${action.what}>`;
            } else {
              actionText += action.what;
            }

            const actionDate = new Date();
            actionDate.setTime(action.when * 1000);
            actionText += ` _${actionDate}_`;

            return actionText;
          });

        return message.concat(actionsText).join('\n');
      })
      .reduce((message, currentMessage) => message + currentMessage + '\n\n', '');

    return slackMessage;
  }

  function sendToSlack(soActivities) {
    console.log('Send to Slack');

    if (Object.keys(soActivities).length) {
      const payload = {
        text: makeSlackMessage(soActivities),
        unfurl_links: false,
        username: config.slack.botName,
        as_user: false,
        token: getToken(),
        channel: config.slack.channel
      };

      if (isDryRun()) {
        console.log(payload.text);
      } else {
        request.post({
            url: `${config.slack.apiBaseUrl}/chat.postMessage`,
            form: payload
          },
          function(error, response, body) {
            if (!error && response.statusCode == 200) {
              fs.writeFileSync(config.lastEndFileName, currentTime);
            } else {
              console.error('Error pushing to Slack');
              handleError(error, response, body)
            }
          }
        );
      }
    }
  }

  function getToken() {
    if (config.slack.token) {
      console.warn("\n########################################################");
      console.warn("## Don't use 'config.slack.token' in production mode. ##");
      console.warn("########################################################\n");
    }
    return process.env.SLACK_API_TOKEN || config.slack.token;
  }

  function isDryRun() {
    return process.env.DRY_RUN && process.env.DRY_RUN === "true" || config.dryRun;
  }

  function historyEvent(tl, desc, emoij, link) {
    return {
      when: tl.creation_date,
      who: entities.decode((tl.user || tl.owner).display_name),
      what: desc,
      emoij: emoij,
      link: link
    };
  }

  function getAnswerLink(answerId) {
    return `http://stackoverflow.com/a/${answerId}`;
  }

  function getCommentLink(questionId, answerId, commentId) {
    return `http://stackoverflow.com/questions/${questionId}/${answerId}#comment${commentId}_${answerId}`;
  }

  function getLastTime() {
    let lastTime;
    if (fs.existsSync(config.lastEndFileName)) {
      const encoding = {
        encoding: 'utf8'
      };
      content = fs.readFileSync(config.lastEndFileName, encoding)
      if (content) {
        lastTime = parseInt(content, 10);
      } else {
        lastTime = saveLastTime()
      }
    } else {
        console.log(`No ${config.lastEndFileName} file, making one.`);
        lastTime = saveLastTime()
    }
    return lastTime;
  }

  function saveLastTime(){
      const timeBack = 60 * (config.so.minuteBack || 0) + 60 * 60 * (config.so.hourBack || 0) + 24 * 60 * 60 * (config.so.dayBack || 0);
      const lastTime = currentTime - timeBack;
      fs.writeFileSync(config.lastEndFileName, lastTime);

      return lastTime
  }

  function getJSON(target, success, error) {
    request({
      uri: target,
      gzip: true
    }, function(err, response, body) {
      if (!err && response.statusCode == 200) {
        success(JSON.parse(body), response, body);
      } else {
        console.log('get failed: ', target);
        error(err, response, body);
      }
    });
  }

  function handleError(err, response, body) {
    console.error('Error getting with request: ' + err);
    console.error(err);
    console.error(response);
    // console.error(body);
    process.exit(1);
  }
};
