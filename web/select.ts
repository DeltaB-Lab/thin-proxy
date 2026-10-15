export function enhanceSelect(select: HTMLSelectElement) {
  const label = select.labels?.[0];
  const wrapper = document.createElement('div'); wrapper.className = 'select-control';
  select.before(wrapper); wrapper.append(select); select.hidden = true;
  const trigger = document.createElement('button');
  trigger.type = 'button'; trigger.className = 'select-trigger'; trigger.id = `${select.id}-trigger`;
  trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-controls', `${select.id}-options`);
  if (label) {
    label.id ||= `${select.id}-label`; label.htmlFor = trigger.id;
    trigger.setAttribute('aria-labelledby', label.id);
  }
  const value = document.createElement('span'); value.className = 'select-value';
  const arrow = document.createElement('span'); arrow.className = 'select-arrow'; arrow.setAttribute('aria-hidden', 'true');
  trigger.append(value, arrow);
  const menu = document.createElement('div');
  menu.id = `${select.id}-options`; menu.className = 'select-menu'; menu.setAttribute('role', 'listbox');
  if (label) menu.setAttribute('aria-labelledby', label.id);
  wrapper.append(trigger, menu);
  let active = -1;
  let search = '', searchedAt = 0;
  const enabled = () => Array.from(select.options).map((option, index) => option.disabled ? -1 : index).filter(index => index !== -1);
  function close() {
    menu.hidden = true; trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-activedescendant');
    wrapper.classList.remove('is-open'); search = '';
  }
  function highlight(index: number) {
    active = index;
    Array.from(menu.children).forEach((option, i) => option.classList.toggle('is-active', i === active));
    const option = menu.children[active] as HTMLElement | undefined;
    if (option) {
      trigger.setAttribute('aria-activedescendant', option.id);
      if (option.offsetTop < menu.scrollTop) menu.scrollTop = option.offsetTop;
      else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight)
        menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
    }
  }
  function refresh() {
    close(); value.textContent = select.options[select.selectedIndex]?.textContent ?? '暂无可选项';
    trigger.disabled = select.disabled || !enabled().length;
    menu.replaceChildren(...Array.from(select.options).map((option, index) => {
      const item = document.createElement('div'); item.id = `${select.id}-option-${index}`; item.className = 'select-option';
      item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(option.selected));
      item.setAttribute('aria-disabled', String(option.disabled)); item.textContent = option.textContent;
      item.addEventListener('pointerdown', event => event.preventDefault());
      item.addEventListener('pointermove', () => { if (!option.disabled) highlight(index); });
      item.addEventListener('click', () => choose(index)); return item;
    }));
  }
  function choose(index: number) {
    if (select.disabled || trigger.disabled || !select.options[index] || select.options[index].disabled) return;
    const changed = select.selectedIndex !== index;
    select.selectedIndex = index; close();
    if (changed) {
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    refresh(); trigger.focus();
  }
  function open() {
    if (select.disabled || trigger.disabled) return;
    menu.hidden = false; wrapper.classList.add('is-open'); trigger.setAttribute('aria-expanded', 'true');
    const bounds = trigger.getBoundingClientRect(), dialog = select.closest('dialog')?.getBoundingClientRect();
    const below = Math.min(window.innerHeight, dialog?.bottom ?? window.innerHeight) - bounds.bottom - 12;
    const above = bounds.top - Math.max(0, dialog?.top ?? 0) - 12;
    const upwards = below < Math.min(240, menu.scrollHeight) && above > below;
    menu.classList.toggle('opens-up', upwards);
    menu.style.maxHeight = `${Math.max(60, Math.min(240, upwards ? above : below))}px`;
    highlight(select.options[select.selectedIndex]?.disabled ? enabled()[0] : select.selectedIndex);
  }
  trigger.addEventListener('click', () => { if (menu.hidden) open(); else close(); });
  trigger.addEventListener('keydown', event => {
    if (select.disabled || trigger.disabled) return;
    const indexes = enabled();
    if (event.key === 'Escape') {
      if (!menu.hidden) { event.preventDefault(); event.stopPropagation(); close(); }
    } else if (event.key === 'Tab') close();
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); if (menu.hidden) open(); else choose(active);
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const wasClosed = menu.hidden; if (wasClosed) open();
      if (event.key === 'Home') highlight(indexes[0]);
      else if (event.key === 'End') highlight(indexes[indexes.length - 1]);
      else if (!wasClosed) highlight(indexes[Math.max(0, Math.min(indexes.length - 1, indexes.indexOf(active) + (event.key === 'ArrowDown' ? 1 : -1)))]);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now(); search = (now - searchedAt > 700 ? '' : search) + event.key.toLocaleLowerCase(); searchedAt = now;
      const index = indexes.find(i => select.options[i].textContent?.trim().toLocaleLowerCase().startsWith(search));
      if (index !== undefined) { if (menu.hidden) choose(index); else highlight(index); }
    }
  });
  wrapper.addEventListener('focusout', event => { if (!wrapper.contains(event.relatedTarget as Node | null)) close(); });
  document.addEventListener('pointerdown', event => { if (!wrapper.contains(event.target as Node)) close(); });
  select.addEventListener('change', refresh);
  select.form?.addEventListener('reset', () => queueMicrotask(refresh));
  select.closest('dialog')?.addEventListener('close', close);
  window.addEventListener('resize', close);
  refresh();
  return { refresh, close };
}
