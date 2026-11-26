-- CreateEnum
CREATE TYPE "TourOffer" AS ENUM ('SHARED', 'PRIVATE', 'BOTH');

-- AlterTable
ALTER TABLE "TourRef" ADD COLUMN     "format" "TourOffer",
ADD COLUMN     "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "meetingPoint" JSONB,
ADD COLUMN     "meetingPointUrl" TEXT;
