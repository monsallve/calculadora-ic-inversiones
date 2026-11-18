// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyAmkeBv0PVJhjKl1ixr7RQW4rp0wHFlBNc",
  authDomain: "monsallve-financiero.firebaseapp.com",
  projectId: "monsallve-financiero",
  storageBucket: "monsallve-financiero.firebasestorage.app",
  messagingSenderId: "195986811906",
  appId: "1:195986811906:web:fcdc8073f4154356df0b1b",
  measurementId: "G-74GZ0FJREB"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);