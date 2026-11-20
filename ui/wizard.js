// The "Add department" wizard as a pure reducer. No DOM. Back and Next keep everything typed.
import { addModule, addSource, addSubModule, emptyDepartment, flatSources, removeNode, removeSource, renameNode, templateRoles, validateDepartment, validateName, validatePath } from "./departments.js";

export const STEPS = ["basics", "structure", "sources", "roles", "review"];
export const STEP_TITLES = { basics: "Basics", structure: "Structure", sources: "Sources", roles: "Roles", review: "Review" };

export function initialWizard(templates) {
  const draft = emptyDepartment();
  draft.roles = templateRoles(draft.template, templates);
  return { step: 0, draft, rolesTouched: false, errors: [], dirty: false, templates: templates || null };
}

/** Problems that stop leaving a step forward. Structure and Roles may be left as they are. */
export function stepErrors(state, step = state.step) {
  const d = state.draft;
  const name = STEPS[step];
  if (name === "basics") {
    const e = validateName(d.name);
    return e ? [e] : [];
  }
  if (name === "sources") {
    const out = [];
    for (const s of flatSources(d)) {
      const e = validatePath(s.path);
      if (e) out.push(`Source "${s.label}": ${e}`);
    }
    return out;
  }
  if (name === "review") return validateDepartment(d);
  return [];
}

export function wizardReducer(state, a) {
  const d = state.draft;
  const edit = (draft, extra) => ({ ...state, draft, dirty: true, errors: [], ...extra });
  switch (a.type) {
    case "set":
      return edit({ ...d, [a.field]: a.value });
    case "template":
      return edit({ ...d, template: a.id, roles: state.rolesTouched ? d.roles : templateRoles(a.id, state.templates) });
    case "role":
      return edit({ ...d, roles: { ...d.roles, [a.key]: !!a.value } }, { rolesTouched: true });
    case "resetRoles":
      return edit({ ...d, roles: templateRoles(d.template, state.templates) }, { rolesTouched: false });
    case "addModule":
      return edit(addModule(d, a.name));
    case "addSubModule":
      return edit(addSubModule(d, a.moduleId, a.name));
    case "rename":
      return edit(renameNode(d, a.id, a.name));
    case "remove":
      return edit(removeNode(d, a.id));
    case "addSource":
      return edit(addSource(d, a.target, a.source));
    case "removeSource":
      return edit(removeSource(d, a.id));
    case "next": {
      const errors = stepErrors(state);
      if (errors.length) return { ...state, errors };
      return { ...state, step: Math.min(STEPS.length - 1, state.step + 1), errors: [] };
    }
    case "back":
      return { ...state, step: Math.max(0, state.step - 1), errors: [] };
    case "goto": {
      // Jumping forward re-checks every step passed on the way.
      if (a.step > state.step) {
        for (let i = state.step; i < a.step; i++) {
          const errors = stepErrors(state, i);
          if (errors.length) return { ...state, step: i, errors };
        }
      }
      return { ...state, step: Math.max(0, Math.min(STEPS.length - 1, a.step)), errors: [] };
    }
    case "reset":
      return initialWizard(state.templates);
    default:
      return state;
  }
}

/** The POST body for the API. Ids for the tree come from the draft; the department id is the server's. */
export function createBody(state) {
  const d = state.draft;
  const body = { name: d.name.trim(), template: d.template, color: d.color, roles: d.roles, modules: d.modules, sources: d.sources };
  if (d.description.trim()) body.description = d.description.trim();
  if (d.owner.trim()) body.owner = d.owner.trim();
  return body;
}
