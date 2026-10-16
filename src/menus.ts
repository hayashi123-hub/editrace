export function createMenus(
  run: (action: string) => void,
  beforeOpen: () => void,
  returnFocus: () => void,
) {
  const bar = document.querySelector<HTMLElement>('.menubar')!;
  const menus = [...bar.querySelectorAll<HTMLElement>('.menu')];
  let opened: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function close() {
    clearTimeout(timer);
    for (const menu of menus) {
      menu.querySelector<HTMLElement>('.menu-panel')!.hidden = true;
      menu.querySelector('.menu-trigger')!.setAttribute('aria-expanded', 'false');
    }
    opened = null;
  }
  function open(menu: HTMLElement, keyboard = false) {
    if (document.querySelector('dialog[open]')) return;
    beforeOpen();
    close();
    opened = menu;
    menu.querySelector<HTMLElement>('.menu-panel')!.hidden = false;
    menu.querySelector('.menu-trigger')!.setAttribute('aria-expanded', 'true');
    if (keyboard)
      menu.querySelector<HTMLButtonElement>('.menu-panel button:not(:disabled)')?.focus();
  }
  for (const menu of menus) {
    const trigger = menu.querySelector<HTMLButtonElement>('.menu-trigger')!;
    menu.addEventListener('mouseenter', () => open(menu));
    menu.addEventListener('mouseleave', () => {
      timer = setTimeout(close, 160);
    });
    menu.addEventListener('mousedown', (event) => event.preventDefault());
    trigger.onclick = () => open(menu);
    trigger.onkeydown = (event) => {
      if (['Enter', ' ', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        open(menu, true);
      }
    };
  }
  bar.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
    if (!button || button.disabled) return;
    close();
    returnFocus();
    run(button.dataset.action!);
  });
  bar.addEventListener('keydown', (event) => {
    if (!opened) return;
    const buttons = [
      ...opened.querySelectorAll<HTMLButtonElement>('.menu-panel button:not(:disabled)'),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[
        (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
      ]?.focus();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      open(
        menus[
          (menus.indexOf(opened) + (event.key === 'ArrowRight' ? 1 : -1) + menus.length) %
            menus.length
        ],
        true,
      );
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!bar.contains(event.target as Node)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && opened) {
      close();
      returnFocus();
    }
  });
  window.addEventListener('blur', close);
  return { close };
}
