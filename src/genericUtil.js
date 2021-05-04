function sleep(millis) {
  return new Promise(resolve => setTimeout(resolve, millis));
}

var ucounter = 0;
function getUniqueId() {
  return ucounter++;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase()+s.substring(1,s.length);
}


module.exports.sleep = sleep;
module.exports.getUniqueId = getUniqueId;
module.exports.capitalize = capitalize;