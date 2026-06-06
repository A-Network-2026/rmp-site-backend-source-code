const BASE_RATE = 0.001;
const MAX_SUPPLY = 21000000;

/// 🔥 Calculate mining rate (reverse halving)
function calculateRate(halvingCount) {
  return BASE_RATE * (1 + halvingCount);
}

module.exports = {
  calculateRate,
  MAX_SUPPLY
};