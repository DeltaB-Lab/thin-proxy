// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enhanceSelect } from '../web/select';

function fixture() {
  document.body.innerHTML = `<form><label for="auth">鉴权方式</label><select id="auth" name="authType">
    <option value="bearer">Authorization: Bearer</option><option value="blocked" disabled>Blocked</option>
    <option value="x-api-key">x-api-key</option></select><input name="other"><button type="submit">保存</button></form>`;
  const select = document.querySelector('select')!;
  const control = enhanceSelect(select);
  const trigger = document.querySelector<HTMLButtonElement>('[role=combobox]')!;
  const key = (value: string) => trigger.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  return { select, control, trigger, key, menu: document.querySelector<HTMLElement>('[role=listbox]')!, form: document.querySelector('form')! };
}

describe('shared select control', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it('commits a pointer choice to the form and emits one input/change without submitting', () => {
    const { select, trigger, form, menu } = fixture();
    const input = vi.fn(), change = vi.fn(), submit = vi.fn();
    form.addEventListener('input', input); form.addEventListener('change', change); form.addEventListener('submit', submit);
    trigger.click(); (menu.children[2] as HTMLElement).click();
    expect(new FormData(form).get('authType')).toBe('x-api-key');
    expect(select.value).toBe('x-api-key'); expect(trigger.textContent).toBe('x-api-key');
    expect(input).toHaveBeenCalledTimes(1); expect(change).toHaveBeenCalledTimes(1); expect(submit).not.toHaveBeenCalled();
    expect(menu.hidden).toBe(true); expect(document.activeElement).toBe(trigger);
  });

  it('navigates past disabled choices and cancels with Escape or commits with Enter', () => {
    const { select, trigger, key, menu } = fixture();
    key('ArrowDown'); key('ArrowDown');
    expect(trigger.getAttribute('aria-activedescendant')).toBe('auth-option-2');
    expect(select.value).toBe('bearer');
    key('Escape'); expect(menu.hidden).toBe(true); expect(select.value).toBe('bearer');
    key(' '); key('End'); key('Enter'); expect(select.value).toBe('x-api-key');
    key(' '); key('Home'); key('Enter'); expect(select.value).toBe('bearer');
  });

  it('refreshes programmatic values, form reset, and replacement options', async () => {
    const { select, control, trigger, form, menu } = fixture();
    select.value = 'x-api-key'; control.refresh(); expect(trigger.textContent).toBe('x-api-key');
    form.reset(); await Promise.resolve(); expect(trigger.textContent).toBe('Authorization: Bearer');
    const option = document.createElement('option'); option.value = 'c'; option.textContent = '上游 C';
    select.replaceChildren(option); control.refresh();
    expect(trigger.textContent).toBe('上游 C'); expect(menu.children).toHaveLength(1);
    expect(new FormData(form).get('authType')).toBe('c');
    select.replaceChildren(); control.refresh(); expect(trigger.disabled).toBe(true);
  });

  it('closes on focus/outside interactions and prevents changes when disabled', () => {
    const { select, control, trigger, key, menu } = fixture();
    trigger.focus(); trigger.click(); document.querySelector('input')!.focus(); expect(menu.hidden).toBe(true);
    trigger.click(); document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); expect(menu.hidden).toBe(true);
    trigger.click(); key('Tab'); expect(menu.hidden).toBe(true);
    trigger.click(); select.disabled = true; control.refresh();
    expect(menu.hidden).toBe(true); expect(trigger.disabled).toBe(true);
    trigger.click(); key('End'); key('Enter'); expect(select.value).toBe('bearer');
  });

  it('supports typing and keeps focus and selection semantics associated with the label', () => {
    const { trigger, key, select, menu } = fixture();
    expect(document.querySelector('label')!.htmlFor).toBe(trigger.id);
    expect(trigger.getAttribute('aria-labelledby')).toBe('auth-label');
    trigger.click(); key('x');
    expect(select.value).toBe('bearer'); key('Enter');
    expect(select.value).toBe('x-api-key'); expect(menu.children[2].getAttribute('aria-selected')).toBe('true');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
