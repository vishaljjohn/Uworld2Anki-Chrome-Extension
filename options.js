// UWorld2Anki — options page

const DEFAULTS = { step: '1' };
let saveTimer;

function stepLabel(s) {
  return s === '3' ? 'Step3' : s === '2' ? 'Step2' : 'Step1';
}

function updatePreview(step) {
  document.getElementById('preview').innerHTML =
    `tag:#AK_<span class="hl">${stepLabel(step)}</span>_v*::#UWorld*::{qid}`;
}

function syncSelected(step) {
  document.querySelectorAll('.opt').forEach(opt =>
    opt.classList.toggle('selected', opt.dataset.value === step)
  );
}

function save(step) {
  chrome.storage.sync.set({ step }, () => {
    const banner = document.getElementById('savedBanner');
    banner.classList.add('show');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => banner.classList.remove('show'), 2500);
  });
}

chrome.storage.sync.get(DEFAULTS, ({ step }) => {
  syncSelected(step);
  updatePreview(step);
  document.querySelector(`input[name=step][value="${step}"]`).checked = true;
});

document.querySelectorAll('.opt').forEach(opt => {
  opt.addEventListener('click', () => {
    const step = opt.dataset.value;
    opt.querySelector('input').checked = true;
    syncSelected(step);
    updatePreview(step);
    save(step);
  });
});
