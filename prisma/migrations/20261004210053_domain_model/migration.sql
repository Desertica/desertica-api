-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('USD', 'PEN');

-- CreateEnum
CREATE TYPE "IdDocType" AS ENUM ('DNI', 'CE', 'PASSPORT', 'RUC');

-- CreateEnum
CREATE TYPE "TourFormat" AS ENUM ('SHARED', 'PRIVATE');

-- CreateEnum
CREATE TYPE "PriceUnit" AS ENUM ('PER_PERSON', 'PER_GROUP');

-- CreateEnum
CREATE TYPE "DepartureStatus" AS ENUM ('OPEN', 'CLOSED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('WEB', 'MANUAL');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE', 'CULQI', 'MANUAL');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'WALLET', 'YAPE', 'CASH', 'TRANSFER', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('FULL', 'DEPOSIT', 'BALANCE');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'REQUIRES_ACTION', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'WON', 'LOST', 'CLOSED');

-- CreateEnum
CREATE TYPE "SunatEnvironment" AS ENUM ('BETA', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('BOLETA', 'FACTURA', 'NOTA_CREDITO', 'NOTA_DEBITO');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'ISSUED', 'ACCEPTED', 'REJECTED', 'VOIDED', 'ERROR');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "LegalDocumentKind" AS ENUM ('TERMS', 'PRIVACY', 'CANCELLATION', 'COOKIES', 'CONDUCT');

-- CreateEnum
CREATE TYPE "WaiverStatus" AS ENUM ('PENDING', 'SIGNED');

-- CreateEnum
CREATE TYPE "ComplaintKind" AS ENUM ('RECLAMO', 'QUEJA');

-- CreateEnum
CREATE TYPE "ComplaintGoodType" AS ENUM ('PRODUCT', 'SERVICE');

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'ANSWERED');

-- CreateEnum
CREATE TYPE "BlockedKind" AS ENUM ('EMAIL', 'IP');

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "permissions" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "googleSub" TEXT,
    "roleId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "country" TEXT,
    "idDocType" "IdDocType",
    "idDocNumber" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'es',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CancellationPolicy" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "tiers" JSONB NOT NULL,
    "depositRefundable" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CancellationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TourRef" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "durationHours" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "requiresWaiver" BOOLEAN NOT NULL DEFAULT true,
    "minAge" INTEGER,
    "minHeightCm" INTEGER,
    "defaultCapacity" INTEGER,
    "cancellationPolicyId" TEXT,
    "cmsSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TourRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Departure" (
    "id" TEXT NOT NULL,
    "tourRefId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "format" "TourFormat" NOT NULL DEFAULT 'SHARED',
    "language" TEXT NOT NULL DEFAULT 'es',
    "status" "DepartureStatus" NOT NULL DEFAULT 'OPEN',
    "meetingPoint" TEXT,
    "guideName" TEXT,
    "vehicleNote" TEXT,
    "notes" TEXT,
    "cutoffMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Departure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceRule" (
    "id" TEXT NOT NULL,
    "tourRefId" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "format" "TourFormat" NOT NULL DEFAULT 'SHARED',
    "unit" "PriceUnit" NOT NULL DEFAULT 'PER_PERSON',
    "adultCents" INTEGER NOT NULL,
    "childCents" INTEGER,
    "groupCents" INTEGER,
    "minPeople" INTEGER,
    "maxPeople" INTEGER,
    "validFrom" DATE,
    "validTo" DATE,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Blackout" (
    "id" TEXT NOT NULL,
    "tourRefId" TEXT,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Blackout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Hold" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "departureId" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Hold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "source" "BookingSource" NOT NULL DEFAULT 'WEB',
    "departureId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "holdId" TEXT,
    "currency" "Currency" NOT NULL,
    "adults" INTEGER NOT NULL,
    "children" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL,
    "depositCents" INTEGER,
    "paidCents" INTEGER NOT NULL DEFAULT 0,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "priceSnapshot" JSONB NOT NULL,
    "cancellationSnapshot" JSONB NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'es',
    "notes" TEXT,
    "billing" JSONB NOT NULL,
    "attribution" JSONB,
    "createdByUserId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Passenger" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "idDocType" "IdDocType",
    "idDocNumber" TEXT,
    "birthDate" DATE,
    "nationality" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,

    CONSTRAINT "Passenger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "kind" "PaymentKind" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "currency" "Currency" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "providerRef" TEXT,
    "providerPayload" JSONB,
    "failureCode" TEXT,
    "recordedByUserId" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentLink" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "kind" "PaymentKind" NOT NULL,
    "currency" "Currency" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "providerRef" TEXT,
    "policyTier" JSONB,
    "requestedByUserId" TEXT,
    "approvedByUserId" TEXT,
    "creditNoteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerRef" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "reason" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL,
    "evidenceDueAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "ruc" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradeName" TEXT,
    "fiscalAddress" TEXT NOT NULL,
    "ubigeo" TEXT,
    "igvRate" DECIMAL(5,4) NOT NULL DEFAULT 0.18,
    "environment" "SunatEnvironment" NOT NULL DEFAULT 'BETA',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Series" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "docType" "DocumentType" NOT NULL,
    "prefix" TEXT NOT NULL,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "paymentId" TEXT,
    "seriesId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "docType" "DocumentType" NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "currency" "Currency" NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "taxableCents" INTEGER NOT NULL,
    "igvCents" INTEGER NOT NULL,
    "exchangeRate" DECIMAL(10,4),
    "customerSnapshot" JSONB NOT NULL,
    "xmlKey" TEXT,
    "cdrKey" TEXT,
    "pdfKey" TEXT,
    "sunatCode" TEXT,
    "sunatMessage" TEXT,
    "relatedDocumentId" TEXT,
    "issuedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT,
    "channel" "NotificationChannel" NOT NULL,
    "template" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegalDocument" (
    "id" TEXT NOT NULL,
    "kind" "LegalDocumentKind" NOT NULL,
    "locale" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "cmsSlug" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegalDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Acceptance" (
    "id" TEXT NOT NULL,
    "legalDocumentId" TEXT NOT NULL,
    "bookingId" TEXT,
    "customerId" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "Acceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Waiver" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "passengerId" TEXT,
    "tourRefId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "WaiverStatus" NOT NULL DEFAULT 'PENDING',
    "signerName" TEXT,
    "signerDocType" "IdDocType",
    "signerDocNumber" TEXT,
    "onBehalfOfMinor" BOOLEAN NOT NULL DEFAULT false,
    "medicalNotes" TEXT,
    "signedAt" TIMESTAMP(3),
    "ip" TEXT,
    "pdfKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Waiver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Complaint" (
    "id" SERIAL NOT NULL,
    "kind" "ComplaintKind" NOT NULL,
    "goodType" "ComplaintGoodType" NOT NULL,
    "consumerName" TEXT NOT NULL,
    "idDocType" "IdDocType" NOT NULL,
    "idDocNumber" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "isMinor" BOOLEAN NOT NULL DEFAULT false,
    "bookingRef" TEXT,
    "amountCents" INTEGER,
    "currency" "Currency",
    "description" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "request" TEXT NOT NULL,
    "status" "ComplaintStatus" NOT NULL DEFAULT 'OPEN',
    "answer" TEXT,
    "answeredAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Complaint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "anonymousId" TEXT NOT NULL,
    "categories" JSONB NOT NULL,
    "policyVersion" INTEGER NOT NULL,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "BlockedIdentity" (
    "id" TEXT NOT NULL,
    "kind" "BlockedKind" NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Role_key_key" ON "Role"("key");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "Customer_email_idx" ON "Customer"("email");

-- CreateIndex
CREATE INDEX "Customer_idDocType_idDocNumber_idx" ON "Customer"("idDocType", "idDocNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CancellationPolicy_key_version_key" ON "CancellationPolicy"("key", "version");

-- CreateIndex
CREATE UNIQUE INDEX "TourRef_slug_key" ON "TourRef"("slug");

-- CreateIndex
CREATE INDEX "Departure_startsAt_idx" ON "Departure"("startsAt");

-- CreateIndex
CREATE INDEX "Departure_tourRefId_startsAt_idx" ON "Departure"("tourRefId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Departure_tourRefId_startsAt_format_language_key" ON "Departure"("tourRefId", "startsAt", "format", "language");

-- CreateIndex
CREATE INDEX "PriceRule_tourRefId_currency_format_idx" ON "PriceRule"("tourRefId", "currency", "format");

-- CreateIndex
CREATE INDEX "Blackout_startsOn_endsOn_idx" ON "Blackout"("startsOn", "endsOn");

-- CreateIndex
CREATE UNIQUE INDEX "Hold_token_key" ON "Hold"("token");

-- CreateIndex
CREATE INDEX "Hold_departureId_expiresAt_idx" ON "Hold"("departureId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_reference_key" ON "Booking"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_holdId_key" ON "Booking"("holdId");

-- CreateIndex
CREATE INDEX "Booking_departureId_status_idx" ON "Booking"("departureId", "status");

-- CreateIndex
CREATE INDEX "Booking_customerId_idx" ON "Booking"("customerId");

-- CreateIndex
CREATE INDEX "Booking_status_createdAt_idx" ON "Booking"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Passenger_bookingId_idx" ON "Passenger"("bookingId");

-- CreateIndex
CREATE INDEX "Payment_bookingId_idx" ON "Payment"("bookingId");

-- CreateIndex
CREATE INDEX "Payment_status_createdAt_idx" ON "Payment"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_provider_providerRef_key" ON "Payment"("provider", "providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentLink_token_key" ON "PaymentLink"("token");

-- CreateIndex
CREATE INDEX "PaymentLink_bookingId_idx" ON "PaymentLink"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_creditNoteId_key" ON "Refund"("creditNoteId");

-- CreateIndex
CREATE INDEX "Refund_paymentId_idx" ON "Refund"("paymentId");

-- CreateIndex
CREATE INDEX "Dispute_paymentId_idx" ON "Dispute"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_provider_providerRef_key" ON "Dispute"("provider", "providerRef");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_eventId_key" ON "WebhookEvent"("provider", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "Company_ruc_key" ON "Company"("ruc");

-- CreateIndex
CREATE UNIQUE INDEX "Series_companyId_prefix_key" ON "Series"("companyId", "prefix");

-- CreateIndex
CREATE INDEX "Document_bookingId_idx" ON "Document"("bookingId");

-- CreateIndex
CREATE INDEX "Document_status_idx" ON "Document"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Document_seriesId_number_key" ON "Document"("seriesId", "number");

-- CreateIndex
CREATE INDEX "Notification_bookingId_idx" ON "Notification"("bookingId");

-- CreateIndex
CREATE INDEX "Notification_status_idx" ON "Notification"("status");

-- CreateIndex
CREATE UNIQUE INDEX "LegalDocument_kind_locale_version_key" ON "LegalDocument"("kind", "locale", "version");

-- CreateIndex
CREATE INDEX "Acceptance_bookingId_idx" ON "Acceptance"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "Waiver_token_key" ON "Waiver"("token");

-- CreateIndex
CREATE INDEX "Waiver_bookingId_idx" ON "Waiver"("bookingId");

-- CreateIndex
CREATE INDEX "Complaint_status_dueAt_idx" ON "Complaint"("status", "dueAt");

-- CreateIndex
CREATE INDEX "ConsentRecord_anonymousId_idx" ON "ConsentRecord"("anonymousId");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BlockedIdentity_kind_value_key" ON "BlockedIdentity"("kind", "value");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TourRef" ADD CONSTRAINT "TourRef_cancellationPolicyId_fkey" FOREIGN KEY ("cancellationPolicyId") REFERENCES "CancellationPolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Departure" ADD CONSTRAINT "Departure_tourRefId_fkey" FOREIGN KEY ("tourRefId") REFERENCES "TourRef"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceRule" ADD CONSTRAINT "PriceRule_tourRefId_fkey" FOREIGN KEY ("tourRefId") REFERENCES "TourRef"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Blackout" ADD CONSTRAINT "Blackout_tourRefId_fkey" FOREIGN KEY ("tourRefId") REFERENCES "TourRef"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hold" ADD CONSTRAINT "Hold_departureId_fkey" FOREIGN KEY ("departureId") REFERENCES "Departure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_departureId_fkey" FOREIGN KEY ("departureId") REFERENCES "Departure"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_holdId_fkey" FOREIGN KEY ("holdId") REFERENCES "Hold"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Passenger" ADD CONSTRAINT "Passenger_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_creditNoteId_fkey" FOREIGN KEY ("creditNoteId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Series" ADD CONSTRAINT "Series_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "Series"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_relatedDocumentId_fkey" FOREIGN KEY ("relatedDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Acceptance" ADD CONSTRAINT "Acceptance_legalDocumentId_fkey" FOREIGN KEY ("legalDocumentId") REFERENCES "LegalDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Acceptance" ADD CONSTRAINT "Acceptance_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Acceptance" ADD CONSTRAINT "Acceptance_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waiver" ADD CONSTRAINT "Waiver_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waiver" ADD CONSTRAINT "Waiver_passengerId_fkey" FOREIGN KEY ("passengerId") REFERENCES "Passenger"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Waiver" ADD CONSTRAINT "Waiver_tourRefId_fkey" FOREIGN KEY ("tourRefId") REFERENCES "TourRef"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
