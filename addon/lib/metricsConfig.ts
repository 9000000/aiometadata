function isMetricsDisabled(): boolean {
  if (process.env.ENABLE_METRICS === 'true' || process.env.DISABLE_METRICS === 'false') {
    return false;
  }
  if (process.env.DISABLE_METRICS === 'true') {
    return true;
  }
  return isLiteMode();
}

/** LITE_MODE=true disables all background warmers, trackers, and heavy init tasks. */
function isLiteMode(): boolean {
  return process.env.LITE_MODE === 'true';
}

export { isMetricsDisabled, isLiteMode };
module.exports = { isMetricsDisabled, isLiteMode };

