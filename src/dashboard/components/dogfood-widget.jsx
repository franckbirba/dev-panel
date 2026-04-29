// DEVPA-167 — dogfooding interne du widget DevPanel sur dev-panel.devpanl.dev.
//
// On monte le widget que l'on vend (chat + bug/feature) sur notre propre
// dashboard, en utilisant le projet courant comme cible. Les bugs/captures
// remontent donc dans la base que l'équipe utilise déjà pour son triage.
//
// Le composant est un no-op tant qu'aucun projet n'est sélectionné — pas de
// FAB orphelin avant que l'utilisateur ait rattaché ses projets via SSO.
import { DevPanel } from '../../react/DevPanel.jsx';

function deriveEnvironment(hostname) {
  if (!hostname || typeof hostname !== 'string') return undefined;
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return 'development';
  }
  if (hostname.endsWith('.devpanl.dev') || hostname === 'devpanl.dev') {
    return 'production';
  }
  return undefined;
}

export function DogfoodWidget({
  apiUrl,
  apiKey,
  hostname = (typeof window !== 'undefined' ? window.location.hostname : '')
}) {
  if (!apiKey) return null;
  const environment = deriveEnvironment(hostname);
  return (
    <DevPanel
      apiUrl={apiUrl}
      apiKey={apiKey}
      environment={environment}
      chat
    />
  );
}
