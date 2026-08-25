/* Modal dialogs: opening them, closing them, and keeping the keyboard inside.
 *
 * Focus is trapped in the top-most dialog and returned to whatever opened it,
 * so the app stays usable without a mouse.
 */
'use strict';

/* Every modal is a plain div over a backdrop rather than a <dialog>, so the
   three things the platform would have given us — a role, focus that starts
   inside and cannot leave, and focus that goes back afterwards — have to be
   done here. Without the trap, Tab walks straight out of the card and onto the
   controls behind it, which are unreachable by mouse and still operable by
   keyboard. */

const DIALOGS = ['helpModal', 'startDialog', 'exportDialog'];

/** Whichever dialog is on top, or null when none is open. */
function openDialog() {
  return DIALOGS.map($).find((el) => !el.classList.contains('hidden')) || null;
}

let returnFocusTo = null;

function rememberFocus() {
  returnFocusTo = document.activeElement;
}

/** Send focus back where it came from, so keyboard users don't lose their place. */
function restoreFocus() {
  if (returnFocusTo && returnFocusTo.focus) returnFocusTo.focus();
  returnFocusTo = null;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Keep Tab inside the open dialog rather than letting it wander behind. */
function trapFocus(e, dialog) {
  if (e.key !== 'Tab') return;
  const items = [...dialog.querySelectorAll(FOCUSABLE)].filter(
    (el) => !el.disabled && el.offsetParent !== null,
  );
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function closeExportDialog() {
  $('exportDialog').classList.add('hidden');
  restoreFocus();
}

/** Close whichever dialog is on top. Returns false when none was open. */
function closeTopDialog() {
  const el = openDialog();
  if (!el) return false;
  if (el.id === 'helpModal') closeHelp();
  else if (el.id === 'startDialog') closeStartDialog();
  else closeExportDialog();
  return true;
}

/* ----------------------------------------------------------- help popups */

function openHelp(topic) {
  const source = document.querySelector(`#helpSources [data-help="${topic}"]`);
  if (!source) return;
  $('helpTitle').textContent = source.dataset.title;
  $('helpBody').innerHTML = source.innerHTML;
  rememberFocus();
  $('helpModal').classList.remove('hidden');
  $('helpClose').focus();
}

function closeHelp() {
  $('helpModal').classList.add('hidden');
  restoreFocus();
}

function bindHelp() {
  for (const button of document.querySelectorAll('.help-btn')) {
    button.onclick = () => openHelp(button.dataset.help);
  }
  $('helpClose').onclick = closeHelp;
  // Clicking the backdrop closes; clicking inside the card does not.
  $('helpModal').onclick = (e) => {
    if (e.target === $('helpModal')) closeHelp();
  };
}

/* ----------------------------------------------------------- start dialog */

/* Unskippable at startup — a program should begin with a name and a target
   length rather than defaults nobody chose. Cancellable when you open it
   yourself from New, so a misclick is not a trap. */
let startDismissable = false;

/** A route out has been chosen, so the start dialog may be dismissed. */
function allowStartDismissal() {
  startDismissable = true;
}

function openStartDialog(dismissable) {
  startDismissable = dismissable;
  const clips = state.clips.length;

  $('startWarn').classList.toggle('hidden', !dismissable || clips === 0);
  if (dismissable && clips) {
    const { total } = layout(state.clips);
    $('startWarnInfo').textContent =
      `“${state.name}” — ${clips} song${clips === 1 ? '' : 's'}, ${fmt(total)}`;
  }
  $('startCancelRow').classList.toggle('hidden', !dismissable);

  $('startName').value = '';
  fillLevelOptions($('startLevel'));
  $('startLevel').value = findLevel(state.level) ? state.level : 'usfs-juv';
  $('startCustomWrap').classList.add('hidden');

  $('startDialog').classList.remove('hidden');
  $('startName').focus();
}

function closeStartDialog() {
  if (!startDismissable) return; // startup: choose a route, don't slip past it
  $('startDialog').classList.add('hidden');
}

function bindStartDialog() {
  $('startLevel').onchange = () => {
    $('startCustomWrap').classList.toggle('hidden', $('startLevel').value !== CUSTOM_LEVEL);
    if ($('startLevel').value === CUSTOM_LEVEL) $('startCustom').focus();
  };
  $('btnStartNew').onclick = startNewProgram;
  $('btnStartCancel').onclick = closeStartDialog;
  $('btnStartLoad').onclick = () => {
    startDismissable = true; // loading a file is a valid way out
    $('startDialog').classList.add('hidden');
    $('projectInput').click();
  };
  $('startDialog').onclick = (e) => {
    if (e.target === $('startDialog')) closeStartDialog();
  };
  for (const id of ['startName', 'startCustom']) {
    $(id).onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        startNewProgram();
      }
    };
  }
}

/* Under Node — the test suite — hand this file's names to app.js, which puts
   them back into the single scope the script tags give them in a browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DIALOGS,
    openDialog,
    returnFocusTo,
    rememberFocus,
    restoreFocus,
    FOCUSABLE,
    trapFocus,
    closeExportDialog,
    closeTopDialog,
    openHelp,
    closeHelp,
    bindHelp,
    startDismissable,
    allowStartDismissal,
    openStartDialog,
    closeStartDialog,
    bindStartDialog,
  };
}
