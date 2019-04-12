const Mailgun = require('mailgun-js');
const humanizeDuration = require('humanize-duration');
const request = require('request-promise-native');
const config = require('./config.json');

const mailgun = new Mailgun({
  apiKey: process.env.MAILGUN_API_KEY,
  domain: config.MAILGUN_DOMAIN,
});

const TRIGGER_ID = '7423c985-2fd2-40f3-abe7-94d4c353eed0';

// The main function called by Cloud Functions.
module.exports.send_email = async event => {
  // Parse the build information.
  const build = JSON.parse(new Buffer(event.data, 'base64').toString());
  // Add 'SUCCESS' to monitor successful builds also.
  const status =
      ['SUCCESS', 'FAILURE', 'INTERNAL_ERROR', 'TIMEOUT', 'CANCELLED'];
  // Email only when the build has failed.
  if (status.indexOf(build.status) === -1) {
    return;
  }
  // Email only on nightly builds.
  if (build.buildTriggerId !== TRIGGER_ID) {
    return;
  }

  let duration =
      humanizeDuration(new Date(build.finishTime) - new Date(build.startTime));
  const msg = `${build.substitutions.REPO_NAME} nightly finished with status ` +
      `${build.status}, in ${duration}.`;

  await sendEmail(build, msg);
  await sendChatMsg(build, msg);
};

async function sendChatMsg(build, msg) {
  const chatMsg = `${msg} <${build.logUrl}|See logs>`;
  const res = await request(process.env.HANGOUTS_URL, {
    resolveWithFullResponse: true,
    method: 'POST',
    json: true,
    body: {text: chatMsg},
  });
  console.log(`statusCode: ${res.statusCode}`);
  console.log(res.body);
}

// createEmail create an email message from a build object.
async function sendEmail(build, msg) {
  // Send an email.
  let emailMsg = `<p>${msg}</p><p><a href="${build.logUrl}">Build logs</a></p>`;
  const email = {
    from: config.MAILGUN_FROM,
    to: config.MAILGUN_TO,
    subject: `Nightly ${build.substitutions.REPO_NAME}: ${build.status}`,
    text: emailMsg,
    html: emailMsg
  };
  await mailgun.messages().send(email);
}
