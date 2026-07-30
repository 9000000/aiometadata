'use strict';

function baseUrlFrom(hostEnv, requestHost) {
  if (hostEnv) {
    return hostEnv.startsWith('http') ? hostEnv : `https://${hostEnv}`;
  }
  return `https://${requestHost}`;
}

function buildInstallUrl(hostEnv, requestHost, identifier) {
  return `${baseUrlFrom(hostEnv, requestHost)}/stremio/${identifier}/manifest.json`;
}

module.exports = { baseUrlFrom, buildInstallUrl };
