// Keep the native select as the preference value and change-event source.
export function enhanceDropdown(select) {
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'dropdown-trigger';
  trigger.setAttribute('aria-label', select.getAttribute('aria-label'));
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.id = `${select.id}-menu`;
  menu.className = 'app-dropdown hidden';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', select.getAttribute('aria-label'));
  trigger.setAttribute('aria-controls', menu.id);
  select.hidden = true;
  select.after(trigger);
  document.body.append(menu);

  const options = [...select.options].map((option) => {
    const item = document.createElement('div');
    item.className = 'dropdown-option';
    item.setAttribute('role', 'option');
    item.tabIndex = -1;
    item.textContent = option.textContent;
    item.addEventListener('click', () => choose(option.value));
    menu.append(item);
    return item;
  });

  function sync() {
    trigger.textContent = select.selectedOptions[0]?.textContent || '';
    trigger.title = `${select.getAttribute('aria-label')}: ${trigger.textContent}`;
    trigger.setAttribute('aria-label', trigger.title);
    options.forEach((item, index) => item.setAttribute('aria-selected', String(select.options[index].selected)));
  }
  function close(restoreFocus = false) {
    menu.classList.add('hidden');
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  }
  function open(index = select.selectedIndex) {
    sync();
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 170), window.innerWidth - 16);
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    menu.style.maxHeight = `${Math.max(0, window.innerHeight - rect.bottom - 14)}px`;
    menu.classList.remove('hidden');
    trigger.setAttribute('aria-expanded', 'true');
    options[Math.max(0, index)]?.focus({ preventScroll: true });
    options[Math.max(0, index)]?.scrollIntoView({ block: 'nearest' });
  }
  function choose(value) {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    sync();
    close(true);
  }
  trigger.addEventListener('click', () => menu.classList.contains('hidden') ? open() : close());
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open(event.key === 'ArrowUp' ? options.length - 1 : select.selectedIndex);
    }
  });
  menu.addEventListener('keydown', (event) => {
    const index = options.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % options.length;
    if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = options.length - 1;
    if (event.key.length === 1 && event.key !== ' ') {
      const offset = options.slice(index + 1).concat(options.slice(0, index + 1))
        .find((item) => item.textContent.toLowerCase().startsWith(event.key.toLowerCase()));
      if (offset) next = options.indexOf(offset);
    }
    if (next !== undefined) { event.preventDefault(); options[next].focus(); }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (index >= 0) choose(select.options[index].value);
    }
    if (event.key === 'Escape') { event.preventDefault(); close(true); }
    if (event.key === 'Tab') {
      // Resume the header's normal tab order from the trigger.
      trigger.focus();
      close();
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!menu.contains(event.target) && !trigger.contains(event.target)) close();
  });
  document.addEventListener('focusin', (event) => {
    if (!menu.contains(event.target) && event.target !== trigger) close();
  });
  window.addEventListener('resize', () => close());
  window.addEventListener('scroll', (event) => { if (!menu.contains(event.target)) close(); }, true);
  select.addEventListener('change', sync);
  select.addEventListener('dropdown-sync', sync);
  sync();
}
