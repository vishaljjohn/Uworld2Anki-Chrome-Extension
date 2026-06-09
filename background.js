// UWorld2Anki — background service worker
// Bridge between content.js and AnkiConnect (localhost:8765).
// Handles two actions:
//   ankiBrowse — opens the Anki browser GUI (guiBrowse)
//   ankiCount  — returns the number of matching cards (findCards)

const ANKI_CONNECT_URL     = 'http://localhost:8765';
const ANKI_CONNECT_VERSION = 6;
const FETCH_TIMEOUT_MS     = 8000;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ankiBrowse') {
    return callAnki('guiBrowse', { query: request.query }, sendResponse);
  }
  if (request.action === 'ankiCount') {
    return callAnki('findCards', { query: request.query }, sendResponse);
  }
  return false;
});

function callAnki(action, params, sendResponse) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  fetch(ANKI_CONNECT_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action, version: ANKI_CONNECT_VERSION, params }),
    signal:  controller.signal,
  })
    .then((res) => {
      clearTimeout(timeout);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        throw new Error(`Unexpected response type: ${ct} (status ${res.status})`);
      }
      return res.json();
    })
    .then((data) => {
      if (data.error) sendResponse({ error: String(data.error) });
      else            sendResponse({ success: true, result: data.result });
    })
    .catch((err) => {
      clearTimeout(timeout);
      const isTimeout = err.name === 'AbortError';
      sendResponse({
        error: isTimeout
          ? `AnkiConnect timed out after ${FETCH_TIMEOUT_MS / 1000}s. Is Anki open and responsive?`
          : `Cannot reach AnkiConnect at ${ANKI_CONNECT_URL}. Is Anki open? Details: ${err.message}`,
      });
    });

  return true; // keep message channel open for async response
}
