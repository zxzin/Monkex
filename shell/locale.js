/* Select a generated locale before the app starts; task content stays untouched. */
(() => {
  const url = new URL(location.href);
  const requested = url.searchParams.get('lang');
  const language = requested === 'en' || requested === 'zh' ? requested
    : (navigator.language || 'en').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  const englishPage = url.pathname.includes('/en/');
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  if ((language === 'en') !== englishPage) {
    url.pathname = language === 'en' ? '/shell/en/index.html' : '/shell/index.html';
    location.replace(url.href);
  }
})();
