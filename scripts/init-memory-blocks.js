#!/usr/bin/env node

// Script to initialize default memory blocks for Shelly
import { pool } from '../src/server/pg.js';

const DEFAULT_BLOCKS = [
  {
    block_name: 'profil_franck',
    content: `# Profil Franck

- Lead développeur full-stack
- Expertise principale: TypeScript, Python, PostgreSQL, Docker
- Préférences: code propre, tests automatisés, documentation claire
- Disponibilité: temps plein sur dev-panel et les projets associés
- Communication: préfère les discussions techniques précises`,
    description: 'Profil utilisateur principal de Shelly'
  },
  {
    block_name: 'priorites',
    content: `# Priorités actuelles

1. Stabiliser l'architecture MCP de Shelly (DEVPA-242)
2. Améliorer les capacités d'auto-documentation du code
3. Finaliser l'intégration avec Plane pour le suivi des tâches
4. Optimiser les performances du système de mémoire vectorielle
5. Développer les outils de génération de code assistée`,
    description: 'Priorités de développement courantes'
  },
  {
    block_name: 'regles',
    content: `# Règles de fonctionnement

- Toujours suivre les conventions de codage du projet
- Écrire des tests unitaires pour chaque nouvelle fonctionnalité
- Documenter les décisions techniques importantes dans la mémoire
- Respecter les limites de caractères pour les blocs de mémoire
- Utiliser des commits conventionnels (feat:, fix:, test:, etc.)`,
    description: 'Règles et contraintes de développement'
  },
  {
    block_name: 'etat_projets',
    content: `# État des projets

## dev-panel (principal)
- Statut: Actif
- Focus: Infrastructure d'agents et orchestration

## Zeno
- Statut: En cours
- Focus: Système de gestion documentaire

## EDMS
- Statut: Planifié
- Focus: Système de gestion électronique de documents`,
    description: 'État courant des projets'
  }
];

async function initMemoryBlocks() {
  const namespace = 'dev-panel';
  
  console.log(`Initializing memory blocks in namespace: ${namespace}`);
  
  for (const block of DEFAULT_BLOCKS) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO memory_blocks (namespace, block_name, content, char_limit)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (namespace, block_name) 
         DO UPDATE SET content = $3, char_limit = $4, updated_at = NOW()
         RETURNING id`,
        [namespace, block.block_name, block.content, 2000]
      );
      
      console.log(`✓ Created/updated block: ${block.block_name}`);
    } catch (err) {
      console.error(`✗ Failed to create/update block ${block.block_name}:`, err.message);
    }
  }
  
  console.log('Memory blocks initialization complete');
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  initMemoryBlocks().catch(console.error);
}

export { initMemoryBlocks, DEFAULT_BLOCKS };