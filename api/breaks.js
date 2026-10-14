const savedReport = require('../data/break-details.json');

module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(savedReport);
};
