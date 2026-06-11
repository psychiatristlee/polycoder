import * as admin from "firebase-admin";
import {FieldValue} from "firebase-admin/firestore";
import {CURRICULUM_2022, CurriculumSeedEntry} from "./curriculum-data.js";

admin.initializeApp();
const db = admin.firestore();

/**
 * Builds embedding text from curriculum entry.
 * @param {CurriculumSeedEntry} entry - The curriculum entry.
 * @return {string} The formatted text.
 */
function buildEmbeddingText(entry: CurriculumSeedEntry): string {
  return [
    `${entry.grade}학년 ${entry.semester}학기 ${entry.unitTitle}`,
    `영역: ${entry.domain}`,
    `학습 목표: ${entry.learningObjectives.join(". ")}`,
    `핵심 개념: ${entry.keyConcepts.join(", ")}`,
    `문제 유형: ${entry.exampleProblemTypes.join(", ")}`,
  ].join("\n");
}

/**
 * Generates document ID for curriculum entry.
 * @param {CurriculumSeedEntry} entry - The curriculum entry.
 * @return {string} The document ID.
 */
function docId(entry: CurriculumSeedEntry): string {
  return `g${entry.grade}s${entry.semester}u${entry.unitNumber}`;
}

/** Seeds curriculum data into Firestore. */
async function seed() {
  console.log(`Seeding ${CURRICULUM_2022.length} curriculum entries...`);

  // Process in batches of 20 for Firestore reliability
  const BATCH_SIZE = 20;
  let count = 0;

  for (let i = 0; i < CURRICULUM_2022.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = CURRICULUM_2022.slice(i, i + BATCH_SIZE);

    for (const entry of chunk) {
      const id = docId(entry);
      const embeddingText = buildEmbeddingText(entry);
      const ref = db.collection("curriculum").doc(id);

      batch.set(ref, {
        grade: entry.grade,
        semester: entry.semester,
        unitNumber: entry.unitNumber,
        unitTitle: entry.unitTitle,
        domain: entry.domain,
        learningObjectives: entry.learningObjectives,
        keyConcepts: entry.keyConcepts,
        exampleProblemTypes: entry.exampleProblemTypes,
        embeddingText,
        createdAt: FieldValue.serverTimestamp(),
        version: "2022",
      });

      count++;
      console.log(
        `  [${count}/${CURRICULUM_2022.length}] ${id} - ${entry.unitTitle}`
      );
    }

    await batch.commit();
    const done = Math.min(i + BATCH_SIZE, CURRICULUM_2022.length);
    console.log(
      `  --- Batch committed (${done}/${CURRICULUM_2022.length}) ---`
    );
  }

  console.log(`\nDone! Seeded ${count} curriculum entries.`);
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
