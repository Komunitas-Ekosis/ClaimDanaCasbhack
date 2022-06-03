import fs from 'fs-extra';
import { join } from 'path';
import ini from 'ini';
import git from 'git-last-commit';
import {
  BitbucketMeta,
  GitHubMeta,
  GitLabMeta,
  GitMeta,
  RepoData,
} from '../../types';
import { Output } from '../output';

function getLastCommit(directory: string): Promise<git.Commit> {
  return new Promise((resolve, reject) => {
    git.getLastCommit(
      (err, commit) => {
        if (err) return reject(err);
        resolve(commit);
      },
      { dst: directory }
    );
  });
}

export async function getRepoData(configPath: string, output: Output) {
  let gitConfig;
  try {
    gitConfig = ini.parse(await fs.readFile(configPath, 'utf-8'));
  } catch (error) {
    output.debug(`Error while parsing repo data: ${error.message}`);
  }
  if (!gitConfig) {
    return;
  }

  const originUrl = gitConfig['remote "origin"']?.url;
  if (originUrl) {
    return parseRepoUrl(originUrl);
  }
}

export function parseRepoUrl(originUrl: string): RepoData | null {
  const isSSH = originUrl.startsWith('git@');
  // Matches all characters between (// or @) and (.com or .org)
  const provider = originUrl.match(/(?<=(\/\/|@)).*(?=(.com|.org))/);
  if (!provider) {
    return null;
  }

  let org;
  let repo;

  if (isSSH) {
    org = originUrl.split(':')[1].split('/')[0];
    repo = originUrl.split('/')[1].replace('.git', '');
  } else {
    // Assume https:// or git://
    org = originUrl.split('/')[3];
    repo = originUrl.split('/')[4].replace('.git', '');
  }

  return {
    provider: provider[0],
    org,
    repo,
  };
}

export async function createGitMeta(
  directory: string,
  output: Output
): Promise<GitMeta> {
  const repoData = await getRepoData(join(directory, '.git/config'), output);
  // If we can't get the repo URL, then don't return any metadata
  if (!repoData) {
    return {};
  }
  const commit = await getLastCommit(directory);

  if (repoData.provider === 'github') {
    return populateGitHubData(repoData, commit);
  } else if (repoData.provider === 'gitlab') {
    return populateGitLabData(repoData, commit);
  } else if (repoData.provider === 'bitbucket') {
    return populateBitbucketData(repoData, commit);
  }

  return {};
}

// Populate data for every provider

function populateGitHubData(
  repoData: RepoData,
  commit: git.Commit
): GitHubMeta {
  const data: GitHubMeta = {};

  data.githubOrg = repoData.org;
  data.githubCommitOrg = repoData.org;
  data.githubRepo = repoData.repo;
  data.githubCommitRepo = repoData.repo;

  data.githubCommitAuthorName = commit.author.name;
  data.githubCommitMessage = commit.subject;
  if (data.githubOrg) {
    data.githubCommitOrg = data.githubOrg;
  }
  data.githubCommitRef = commit.branch;
  if (data.githubRepo) {
    data.githubCommitRepo = data.githubRepo;
  }
  data.githubCommitSha = commit.hash;

  data.githubDeployment = '1';

  return data;
}

function populateGitLabData(
  repoData: RepoData,
  commit: git.Commit
): GitLabMeta {
  const data: GitLabMeta = {};

  if (repoData.org && repoData.repo) {
    data.gitlabProjectPath = `${repoData.org}/${repoData.repo}`;
  }

  data.gitlabCommitAuthorName = commit.author.name;
  data.gitlabCommitMessage = commit.subject;
  data.gitlabCommitRef = commit.branch;
  data.gitlabCommitSha = commit.hash;
  data.gitlabDeployment = '1';

  return data;
}

function populateBitbucketData(
  repoData: RepoData,
  commit: git.Commit
): BitbucketMeta {
  const data: BitbucketMeta = {};

  data.bitbucketRepoOwner = repoData.org;
  data.bitbucketRepoSlug = repoData.repo;
  data.bitbucketCommitAuthorName = commit.author.name;
  data.bitbucketCommitMessage = commit.subject;
  data.bitbucketCommitRef = commit.branch;
  data.bitbucketCommitSha = commit.hash;
  data.bitbucketDeployment = '1';

  return data;
}
