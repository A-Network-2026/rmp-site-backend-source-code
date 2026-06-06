const en = require('../i18n/en.json');
const tl = require('../i18n/tl.json');

const dictionaries = {
  en,
  tl,
};

function normalizeLang(lang) {
  const normalized = String(lang || 'en').trim().toLowerCase();
  return dictionaries[normalized] ? normalized : 'en';
}

function t(key, lang) {
  const language = normalizeLang(lang);
  const dict = dictionaries[language] || dictionaries.en;
  if (Object.prototype.hasOwnProperty.call(dict, key)) {
    return dict[key];
  }
  if (Object.prototype.hasOwnProperty.call(dictionaries.en, key)) {
    return dictionaries.en[key];
  }
  return key;
}

module.exports = {
  t,
  normalizeLang,
};
