// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

export async function sha256(message: string) {
  // Encode the string as UTF-8
  const msgBuffer = new TextEncoder().encode(message);
  
  // Hash the message
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  
  // Convert ArrayBuffer to hex string
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  return hashHex;
}
