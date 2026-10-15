/**
 * `node:sqlite` est encore marqué « expérimental » par Node : ce filtre masque
 * uniquement cet avertissement précis (CLI et tests) pour garder une sortie propre.
 * Les autres avertissements sont transmis normalement.
 *
 * Note : l'avertissement est émis par le code natif de Node, qui contourne
 * `process.emitWarning` — il faut donc remplacer le listener par défaut de
 * l'événement `'warning'`. (Vérifié sur Node 22.23 : sans ce filtre, l'override
 * de `process.emitWarning` ne l'intercepte pas.)
 *
 * ⚠ L'installation se fait à l'import du module : il doit être importé AVANT
 * tout module important `node:sqlite`.
 */
let installed = false;

export function silenceSqliteExperimentalWarning(): void {
  if (installed) return;
  installed = true;

  // On capture le(s) listener(s) par défaut (l'impression native) pour pouvoir
  // les déléguer tels quels pour tout avertissement qui n'est pas celui de SQLite.
  const defaultListeners = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (warning: Error) => {
    if (warning.message.includes('SQLite is an experimental feature')) return;
    for (const listener of defaultListeners) listener.call(process, warning);
  });
}

silenceSqliteExperimentalWarning();
