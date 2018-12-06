import getScope from './get-scope';

export default async (sentry, error, apiUrl, configFiles) => {
  let user = null;
  let team = null;

  try {
    const {token} = configFiles.readAuthConfigFile();
    const {currentTeam} = configFiles.readConfigFile();

    ({user, team} = await getScope({
      apiUrl,
      token,
      debug: false,
      required: new Set(['user', 'team']),
      currentTeam
    }));
  } catch (err) {
    // We can safely ignore this, as the error
    // reporting works even without this metadata attached.
  }

  if (user || team) {
    sentry.withScope(scope => {
      if (user) {
        scope.setUser({
          email: user.email,
          id: user.uid
        });
      }

      if (team) {
        scope.setTag('currentTeam', team.id);
      }

      sentry.captureException(error);
    });
  } else {
    sentry.captureException(error);
  }

  const client = sentry.getCurrentHub().getClient();

  if (client) {
    await client.close();
  }
};
