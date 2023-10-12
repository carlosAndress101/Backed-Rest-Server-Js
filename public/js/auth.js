
const url = (window.location.hostname.includes('localhost'))
                    ? 'http://localhost:4321/api/auth/google'
                    : 'https://hookcoffee.zeabur.app/api/auth/google'

function handleCredentialResponse(response) {


    const body = { id_token: response.credential }

    fetch( url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify( body )
    })
    .then( resp => resp.json() )
    .then( ({token}) => {
        localStorage.setItem('token', token)
    } )
    .catch( console.log );
     
}

const button = document.querySelector('#g-signout');
button.onclick = async () => {
    google.accounts.id.disableAutoSelect()
    google.accounts.id.revoke(localStorage.getItem('email'), done => {
        localStorage.clear();
        location.reload();
    })
}