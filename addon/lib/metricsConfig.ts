function isMetricsDisabled(): boolean {
  return process.env.DISABLE_METRICS === 'true' || isLiteMode();
}

/** LITE_MODE=true disables all background warmers, trackers, and heavy init tasks. */
function isLiteMode(): boolean {
  return process.env.LITE_MODE === 'true';
}

export { isMetricsDisabled, isLiteMode };
module.exports = { isMetricsDisabled, isLiteMode };
