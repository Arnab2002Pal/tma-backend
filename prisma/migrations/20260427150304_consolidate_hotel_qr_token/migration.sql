/*
  Warnings:

  - You are about to drop the column `token` on the `hotels` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[qrToken]` on the table `hotels` will be added. If there are existing duplicate values, this will fail.
  - The required column `qrToken` was added to the `hotels` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- DropIndex
DROP INDEX "hotels_token_key";

-- AlterTable
ALTER TABLE "hotels" DROP COLUMN "token",
ADD COLUMN     "qrToken" TEXT NOT NULL,
ALTER COLUMN "contactPhone" DROP NOT NULL,
ALTER COLUMN "totalRooms" SET DEFAULT 0;

-- CreateTable
CREATE TABLE "hotel_rooms" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "floorNumber" INTEGER NOT NULL,
    "roomNumber" TEXT NOT NULL,
    "qrUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hotel_rooms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hotel_rooms_hotelId_idx" ON "hotel_rooms"("hotelId");

-- CreateIndex
CREATE UNIQUE INDEX "hotel_rooms_hotelId_roomNumber_key" ON "hotel_rooms"("hotelId", "roomNumber");

-- CreateIndex
CREATE UNIQUE INDEX "hotels_qrToken_key" ON "hotels"("qrToken");

-- AddForeignKey
ALTER TABLE "hotel_rooms" ADD CONSTRAINT "hotel_rooms_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "hotels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
