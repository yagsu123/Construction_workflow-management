// Why is the work not progressing?
//
// The dashboard already answers "which desk is the FILE sitting on". That is administrative
// delay, and it is the corruption signal. It is not the same question as "why is the ROAD not
// getting built", and conflating the two is the fastest way to lose an engineer's trust: a
// package held up by a court stay or by the monsoon is not the JE dragging his feet.
//
// So ground delay is recorded separately, with a coded reason and a responsible party, and the
// two are reported side by side. Attribution is the whole point - a system that blames the
// department for a land acquisition dispute will simply stop being used.

export const PARTY = {
  EXTERNAL:      { id: 'EXTERNAL',      label: 'Outside anyone’s control' },
  DEPARTMENT:    { id: 'DEPARTMENT',    label: 'Department' },
  CONTRACTOR:    { id: 'CONTRACTOR',    label: 'Contractor' },
};

/**
 * `excusable` marks a reason for which an Extension of Time is normally grantable - that is,
 * the contractor is not liquidated-damages liable. It is recorded, not decided, here.
 */
export const REASONS = [
  // --- outside anyone's control -------------------------------------------------------------
  { code: 'LAND_ACQUISITION',    label: 'Land acquisition pending',        party: 'EXTERNAL',   excusable: true },
  { code: 'UTILITY_SHIFTING',    label: 'Utility shifting pending',        party: 'EXTERNAL',   excusable: true,
    hint: 'Electric poles, water mains, telecom ducts not yet relocated' },
  { code: 'STATUTORY_CLEARANCE', label: 'Statutory clearance awaited',     party: 'EXTERNAL',   excusable: true,
    hint: 'Forest, environment, railway or highway authority NOC' },
  { code: 'COURT_STAY',          label: 'Court stay / litigation',         party: 'EXTERNAL',   excusable: true },
  { code: 'ENCROACHMENT',        label: 'Encroachment on alignment',       party: 'EXTERNAL',   excusable: true },
  { code: 'LAW_AND_ORDER',       label: 'Law and order / local agitation', party: 'EXTERNAL',   excusable: true },
  { code: 'WEATHER',             label: 'Monsoon / weather',               party: 'EXTERNAL',   excusable: true,
    hint: 'Work suspended by rain, flooding or unworkable ground' },

  // --- the department's own doing -------------------------------------------------------------
  { code: 'FUNDS_AWAITED',       label: 'Budget release awaited',          party: 'DEPARTMENT', excusable: true },
  { code: 'DRAWING_REVISION',    label: 'Drawing / design revision',       party: 'DEPARTMENT', excusable: true },
  { code: 'SITE_NOT_HANDED_OVER',label: 'Site not handed over',            party: 'DEPARTMENT', excusable: true },
  { code: 'DECISION_AWAITED',    label: 'Departmental decision awaited',   party: 'DEPARTMENT', excusable: true,
    hint: 'Approval pending above the EE, or a policy question unresolved' },

  // --- the contractor's own doing -------------------------------------------------------------
  { code: 'MATERIAL_SHORTAGE',   label: 'Material shortage',               party: 'CONTRACTOR', excusable: false },
  { code: 'LABOUR_SHORTAGE',     label: 'Labour shortage',                 party: 'CONTRACTOR', excusable: false },
  { code: 'EQUIPMENT',           label: 'Plant / equipment breakdown',     party: 'CONTRACTOR', excusable: false },
  { code: 'SLOW_PROGRESS',       label: 'Slow progress / mobilisation',    party: 'CONTRACTOR', excusable: false },
  { code: 'QUALITY_REWORK',      label: 'Rework after quality failure',    party: 'CONTRACTOR', excusable: false },

  { code: 'OTHER',               label: 'Other (explain in remarks)',      party: 'DEPARTMENT', excusable: false },
];

const BY_CODE = new Map(REASONS.map(r => [r.code, r]));

export const reason = code => BY_CODE.get(code) ?? null;
export const isReason = code => BY_CODE.has(code);
export const REASON_CODES = REASONS.map(r => r.code);

/** Whole days between two ISO timestamps, floored at zero. */
export function daysBetween(fromIso, toIso) {
  const ms = new Date(toIso) - new Date(fromIso);
  return Math.max(0, Math.floor(ms / 86_400_000));
}
