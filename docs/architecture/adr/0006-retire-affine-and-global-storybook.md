# ADR 0006 — Retrait d’AFFiNE et du Storybook global du chemin critique

## Status: Accepted

## Context

AFFiNE et le Storybook global n’ont pas trouvé leur place dans le fonctionnement réel de DevPanel. Les maintenir comme dépendances obligatoires ajoute des étapes sans améliorer le delivery. Leurs données historiques conservent néanmoins une valeur de consultation.

## Decision

AFFiNE et le Storybook global quittent le chemin critique. AFFiNE n’est ni une autorité produit ni un passage obligé pour les specs ou décisions. Le Storybook global est remplacé par des previews de la vraie application et des prototypes exécutables, vérifiés avec Playwright, screenshots, parcours et traces.

Aucune nouvelle étape de delivery ne doit dépendre de ces services. Penpot reste optionnel pour un workflow designer/client et ne constitue pas un remplacement obligatoire. Les données AFFiNE et Storybook existantes ne sont pas supprimées pendant la migration, y compris pendant les étapes A à F.

## Consequences

- Les previews applicatives et leurs preuves deviennent le support de validation UI.
- Les specs et décisions actives suivent les autorités Plane et Git définies par les autres ADR.
- Les services legacy peuvent rester consultables pendant l’inventaire et l’export.
- Tout retrait technique ou suppression future exige une décision distincte après vérification des exports et dépendances.

## Alternatives rejected

- Conserver AFFiNE ou le Storybook global comme étapes obligatoires du delivery.
- Remplacer immédiatement ces outils par un Penpot obligatoire.
- Supprimer les données historiques dès la sortie du chemin critique.
- Considérer une bibliothèque de composants isolée comme preuve suffisante du comportement applicatif.

## Migration notes

Inventorier les dépendances, données et exports nécessaires avant toute désactivation. Cesser d’abord les nouvelles dépendances critiques, conserver l’accès historique, puis produire et vérifier les exports. Aucun nettoyage destructif n’est inclus dans cette décision ; le propriétaire et le critère de suppression doivent être établis séparément.
