// UWorld2Anki — popup

const DEFAULTS = { step: '1' };
let currentStep = '1';
let saveTimer, savedTimer;

function stepLabel(s) {
  return s === '3' ? 'Step3' : s === '2' ? 'Step2' : 'Step1';
}

function updatePreview() {
  document.getElementById('preview').innerHTML =
    `tag:#AK_<span class="hl">${stepLabel(currentStep)}</span>_v*::#UWorld*::{qid}`;
}

function setActive(value) {
  document.querySelectorAll('.pill').forEach(p =>
    p.classList.toggle('active', p.dataset.value === value)
  );
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.sync.set({ step: currentStep }, () => {
      const el = document.getElementById('saved');
      el.textContent = '✓ Saved';
      clearTimeout(savedTimer);
      savedTimer = setTimeout(() => { el.textContent = ''; }, 1800);
    });
  }, 150);
}

document.querySelectorAll('.pill').forEach(pill => {
  pill.addEventListener('click', () => {
    currentStep = pill.dataset.value;
    setActive(currentStep);
    updatePreview();
    save();
  });
});

chrome.storage.sync.get(DEFAULTS, ({ step }) => {
  currentStep = step;
  setActive(currentStep);
  updatePreview();
});
