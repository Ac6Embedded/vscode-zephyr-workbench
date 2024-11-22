#!/bin/bash
# Helper script to install udev rules on Linux systems

ARCHIVE_FILE=$1
DESTDIR="/etc/udev/rules.d"
TMPDIR=$3
TMP_EXTRACTED_FOLDER="$TMPDIR/rules"

echo "ARCHIVE_FILE=$ARCHIVE_FILE"
echo "TMP_EXTRACTED_FOLDER=$TMP_EXTRACTED_FOLDER"

mkdir -p $TMP_EXTRACTED_FOLDER
echo "Extracting $ARCHIVE_FILE... into $TMP_EXTRACTED_FOLDER"
tar -xf "$ARCHIVE_FILE" -C "$TMP_EXTRACTED_FOLDER"

echo "############################################################"
echo "#        Install Udev Rules into /etc/udev/rules.d         #"
echo "#              (root permission required)                  #"
echo "############################################################"
for file in $TMP_EXTRACTED_FOLDER/*.rules; do
  sudo echo "Install $file into $DESTDIR..."
  filename=$(basename $file)
  if [ -f "$DESTDIR/$filename" ]; then
    echo "$DESTDIR/$filename already exists"
  else 
    sudo cp "$file" "$DESTDIR"
    sudo chmod 644 "$DESTDIR/$filename"
  fi
done 