// Packages
const chalk = require('chalk');

// Ours
const regexes = require('../../lib/utils/input/regexes');
const wait = require('../../lib/utils/output/wait');
const cfg = require('../../lib/cfg');
const fatalError = require('../../lib/utils/fatal-error');
const cmd = require('../../lib/utils/output/cmd');
const info = require('../../lib/utils/output/info');
const stamp = require('../../lib/utils/output/stamp');
const { tick } = require('../../lib/utils/output/chars');
const rightPad = require('../../lib/utils/output/right-pad');
const textInput = require('../../lib/utils/input/text');
const eraseLines = require('../../lib/utils/output/erase-lines');
const success = require('../../lib/utils/output/success');

function validateEmail(data) {
  return regexes.email.test(data.trim()) || data.length === 0;
}

const domains = Array.from(
  new Set([
    'aol.com',
    'gmail.com',
    'google.com',
    'yahoo.com',
    'ymail.com',
    'hotmail.com',
    'live.com',
    'outlook.com',
    'inbox.com',
    'mail.com',
    'gmx.com',
    'icloud.com'
  ])
);

function emailAutoComplete(value, teamSlug) {
  const parts = value.split('@');

  if (parts.length === 2 && parts[1].length > 0) {
    const [, host] = parts;
    let suggestion = false;

    domains.unshift(teamSlug);
    for (const domain of domains) {
      if (domain.startsWith(host)) {
        suggestion = domain.substr(host.length);
        break;
      }
    }

    domains.shift();
    return suggestion;
  }

  return false;
}

module.exports = async function(
  teams,
  args,
  {
    introMsg,
    noopMsg = 'No changes made'
  } = {}
) {
  const { user, currentTeam } = await cfg.read();

  domains.push(user.email.split('@')[1]);

  if (!currentTeam) {
    let err = `You're currently under the user context "${chalk.bold('sjobs')}"\n`;
    err += `${chalk.gray('>')} Run ${cmd('now switch')} to switch to a team.`;
    return fatalError(err);
  }

  info(introMsg || `Inviting team members to ${chalk.bold(currentTeam.name)}`);

  if (args.length > 0) {
    for (const email of args) {
      if (regexes.email.test(email)) {
        const stopSpinner = wait(email);
        const elapsed = stamp();
        // eslint-disable-next-line no-await-in-loop
        await teams.inviteUser({ teamSlug: currentTeam.slug, email });
        stopSpinner();
        console.log(`${chalk.cyan(tick)} ${email} ${elapsed()}`);
      } else {
        console.log(`${chalk.red(`✖ ${email}`)} ${chalk.gray('[invalid]')}`);
      }
    }
    return;
  }

  const inviteUserPrefix = rightPad('Invite User', 14);
  const emails = [];
  let email;
  do {
    email = '';
    try {
      // eslint-disable-next-line no-await-in-loop
      email = await textInput({
        label: `- ${inviteUserPrefix}`,
        validateValue: validateEmail,
        autoComplete: value => emailAutoComplete(value, currentTeam.slug)
      });
    } catch (err) {
      if (err.message !== 'USER_ABORT') {
        throw err;
      }
    }
    let elapsed;
    let stopSpinner;
    if (email) {
      elapsed = stamp();
      stopSpinner = wait(inviteUserPrefix + email);
      // eslint-disable-next-line no-await-in-loop
      await teams.inviteUser({ teamId: 123, email });
      stopSpinner();
      email = `${email} ${elapsed()}`;
      emails.push(email);
      console.log(`${chalk.cyan(tick)} ${inviteUserPrefix}${email}`);
    }
  } while (email !== '');

  eraseLines(emails.length + 2);

  const n = emails.length;
  if (emails.length === 0) {
    info(noopMsg);
  } else {
    success(`Invited ${n} team mate${n > 1 ? 's' : ''}`);
    for (const email of emails) {
      console.log(`${chalk.cyan(tick)} ${inviteUserPrefix}${email}`);
    }
  }
};
