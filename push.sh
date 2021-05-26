#!/bin/sh
echo $1
if [ -z "$1" ]
then echo "usage: push <commit msg>"
  exit 1
else
  npm --no-git-tag-version version patch
  git add .
  git commit -m "$1"
  git push
fi