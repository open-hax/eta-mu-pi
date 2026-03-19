;; ============================================================
;; Skill Graph + Contract Registry (EDN list-forms)
;; ============================================================

(skill-system
  (rule
    "Skills are subordinate protocol modules. They MAY extend mutable protocol.")
  (rule
    "Skills MUST NOT override doctrine/immutable constraints (mission, directives, safety, license, output-shape) unless the user explicitly approves.")
  (rule
    "A skill MAY expose followup registry entries via (exposes (skill-registry ...)) inside its CONTRACT.edn.")
  (rule
    "Registry expansion is bounded and deterministic; ambiguous matches require user choice.")
  (rule
    "If a skill emits EDN contracts/facts in assistant output, they SHOULD appear in fenced ```edn blocks so runtime linting can validate them."))

(skill-registry
  (root "~/.pi/agent/skills")

  ;; root skills
  (entry
    (name "regression-triage")
    (contract "~/.pi/agent/skills/regression-triage/CONTRACT.edn")
    (priority 80))

  (entry
    (name "fork-tax")
    (contract "~/.pi/agent/skills/fork-tax/CONTRACT.edn")
    (priority 90))

  (entry
    (name "spec-driven-dev")
    (contract "~/.pi/agent/skills/spec-driven-dev/CONTRACT.edn")
    (priority 70))

  (entry
    (name "promptdb-contracts")
    (contract "~/.pi/agent/skills/promptdb-contracts/CONTRACT.edn")
    (priority 60)))
