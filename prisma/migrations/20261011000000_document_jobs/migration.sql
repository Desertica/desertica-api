-- CreateEnum
CREATE TYPE "DocumentJobKind" AS ENUM ('SYNC', 'VOID');

-- CreateEnum
CREATE TYPE "DocumentJobStatus" AS ENUM ('PENDING', 'DONE', 'DEAD');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "reason" TEXT,
ADD COLUMN     "reasonCode" TEXT;

-- CreateTable
CREATE TABLE "DocumentJob" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "kind" "DocumentJobKind" NOT NULL,
    "payload" JSONB,
    "status" "DocumentJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DocumentJob_status_nextAttemptAt_idx" ON "DocumentJob"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "DocumentJob_documentId_idx" ON "DocumentJob"("documentId");

-- AddForeignKey
ALTER TABLE "DocumentJob" ADD CONSTRAINT "DocumentJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
