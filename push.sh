echo $1
if [-z "$1"]
then echo "usage: push <commit msg>"
  exit 1
else
  npm version patch
  git add .
  git commit -m "Commit message"
  git push
fi