export function installEditors({ confirmDiscard, showError }) {
  const dirty = new Set();
  let pending;
  let replaying = false;
  const ask = async () => {
    if (!dirty.size) return true;
    if (!pending) pending = confirmDiscard().then((accepted) => {
      if (accepted) dirty.clear();
      return accepted;
    }).finally(() => { pending = null; });
    return pending;
  };
  for (const eventName of ['input', 'change']) document.addEventListener(eventName, (event) => {
    const form = event.target.closest('form');
    if (form && form.id !== 'custom-payload-form' && !form.closest('dialog')) dirty.add(form.id);
    if (form?.id === 'custom-payload-form') dirty.add(form.id);
  });
  window.addEventListener('beforeunload', (event) => {
    if (dirty.size) { event.preventDefault(); event.returnValue = ''; }
  });
  document.addEventListener('click', async (event) => {
    const action = event.target.closest('[id^="close-"], [id^="new-"], .nav-item, [data-panel-jump], .storage-tab, .record-row:not(.profile-row), .profile-controls button');
    if (!action || replaying || !dirty.size) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      if (await ask()) {
        replaying = true;
        action.click();
        replaying = false;
      }
    } catch (error) { replaying = false; showError(error); }
  }, true);

  const dialog = document.querySelector('#expanded-editor');
  const value = document.querySelector('#expanded-editor-value');
  let source;
  document.querySelectorAll('textarea:not(#expanded-editor-value)').forEach((textarea) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button secondary small expand-editor';
    button.textContent = 'Expand';
    button.setAttribute('aria-label', `Expand ${textarea.closest('label')?.firstChild?.textContent.trim() || 'text editor'}`);
    // Put the control outside labels to avoid forwarding its clicks to the textarea.
    const label = textarea.closest('label');
    (label || textarea).after(button);
    button.addEventListener('click', () => {
      source = textarea;
      value.value = textarea.value;
      value.readOnly = textarea.readOnly;
      document.querySelector('#expanded-editor-apply').textContent = textarea.readOnly ? 'Done' : 'Apply';
      dialog.returnValue = '';
      dialog.showModal();
      value.focus();
    });
  });
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'apply' && source && !source.readOnly && source.value !== value.value) {
      source.value = value.value;
      source.dispatchEvent(new Event('input', { bubbles: true }));
    }
    source?.focus();
    source = null;
  });
  return { ask, saved: (id) => dirty.delete(id) };
}
