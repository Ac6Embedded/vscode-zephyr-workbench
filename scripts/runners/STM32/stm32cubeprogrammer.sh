#!/bin/bash
# Helper script to run STM32CubeProgrammer Installer

ARCHIVE_FILE=$1
DESTDIR=$2
TMPDIR=$3
TMP_EXTRACTED_FOLDER="$TMPDIR/stm32cubeprogrammer"

echo "ARCHIVE_FILE=$ARCHIVE_FILE"
echo "DESTDIR=$DESTDIR"
echo "TMP_EXTRACTED_FOLDER=$TMP_EXTRACTED_FOLDER"


mkdir -p $TMP_EXTRACTED_FOLDER
echo "Extracting $ARCHIVE_FILE... into $TMP_EXTRACTED_FOLDER"
unzip -o "$ARCHIVE_FILE" -d "$TMP_EXTRACTED_FOLDER"

echo "Run installer..."
cd "$TMP_EXTRACTED_FOLDER"
./SetupSTM32CubeProgrammer-2.17.0.linux
cd -
