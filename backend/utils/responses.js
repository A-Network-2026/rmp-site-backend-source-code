const { t } = require('./i18n');

function fail(reply, statusCode, key, lang = 'en', extra = {}) {
  return reply.code(statusCode).send({
    success: false,
    message: t(key, lang),
    ...extra,
  });
}

function ok(payload = {}) {
  return {
    success: true,
    ...payload,
  };
}

module.exports = {
  fail,
  ok,
};
