-- Los descargos pasan a ser documentos legales por tour (tipo WAIVER) con snapshot inmutable;
-- la versión del documento deja de ser única solo por (tipo, idioma) y pasa a serlo también por tour.

-- AlterEnum
ALTER TYPE "LegalDocumentKind" ADD VALUE IF NOT EXISTS 'WAIVER';

-- DropIndex
DROP INDEX "LegalDocument_kind_locale_version_key";

-- AlterTable
ALTER TABLE "LegalDocument" ADD COLUMN     "scopeKey" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "tourRefId" TEXT;

-- AlterTable
ALTER TABLE "Waiver" ADD COLUMN     "legalDocumentId" TEXT;

-- CreateIndex
CREATE INDEX "LegalDocument_tourRefId_idx" ON "LegalDocument"("tourRefId");

-- CreateIndex
CREATE UNIQUE INDEX "LegalDocument_kind_locale_scopeKey_version_key" ON "LegalDocument"("kind", "locale", "scopeKey", "version");

-- AddForeignKey
ALTER TABLE "LegalDocument" ADD CONSTRAINT "LegalDocument_tourRefId_fkey" FOREIGN KEY ("tourRefId") REFERENCES "TourRef"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waiver" ADD CONSTRAINT "Waiver_legalDocumentId_fkey" FOREIGN KEY ("legalDocumentId") REFERENCES "LegalDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

